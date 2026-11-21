import { execFile } from 'node:child_process';
import { createHash } from 'node:crypto';
import { constants } from 'node:fs';
import { mkdir, mkdtemp, open, readFile, rename, rm, stat, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { promisify } from 'node:util';

const run = promisify(execFile);
const worker = fileURLToPath(new URL('./speech-worker.py', import.meta.url));
const model = 'hexgrad/Kokoro-82M';
const modelVersion = '1.0';
const jobTimeout = 15 * 60_000;
const startupTimeout = 15_000;
export const isSpeechJob = id => /^speech-[a-f0-9]{32}$/.test(id);
export const speechModelDirectory = ({ stateDir, speech }) => speech?.modelDir ?? join(stateDir, 'models', 'Kokoro-82M');

async function readJson(file) {
  try { return JSON.parse(await readFile(file, 'utf8')); }
  catch (error) { if (error.code !== 'ENOENT') throw error; return null; }
}

async function waveInfo(file) {
  let handle;
  try {
    handle = await open(file, constants.O_RDONLY | constants.O_NONBLOCK | (constants.O_NOFOLLOW ?? 0));
    const stat = await handle.stat();
    const header = Buffer.alloc(44);
    const { bytesRead } = await handle.read(header, 0, header.length, 0);
    if (!stat.isFile() || bytesRead !== header.length ||
        header.toString('ascii', 0, 4) !== 'RIFF' || header.toString('ascii', 8, 16) !== 'WAVEfmt ' ||
        header.readUInt32LE(16) !== 16 || header.readUInt16LE(20) !== 1 ||
        header.readUInt16LE(22) !== 1 || header.readUInt16LE(34) !== 16 ||
        header.toString('ascii', 36, 40) !== 'data') {
      throw new Error('The speech worker did not produce a mono PCM16 WAV.');
    }
    const dataSize = header.readUInt32LE(40);
    const sampleRate = header.readUInt32LE(24);
    if (!dataSize || dataSize % 2 || !sampleRate || dataSize + header.length !== stat.size ||
        header.readUInt32LE(4) + 8 !== stat.size) {
      throw new Error('The speech worker returned an incomplete WAV.');
    }
    const sampleCount = dataSize / 2;
    return { bytes: stat.size, sampleRate, sampleCount, duration: sampleCount / sampleRate };
  } catch (error) {
    if (error.code !== 'ENOENT') throw error;
    return null;
  } finally {
    await handle?.close();
  }
}

function workerRunning(pid) {
  if (!Number.isInteger(pid) || pid <= 0) return false;
  try { process.kill(pid, 0); return true; }
  catch (error) { return error.code === 'EPERM'; }
}

export class Speech {
  constructor({ stateDir, speech }) {
    this.jobs = join(stateDir, 'speech-jobs');
    this.config = speech ?? { modelDir: speechModelDirectory({ stateDir }), python: 'python3', device: 'cpu' };
    this.configured = Boolean(speech?.modelDir);
  }

  workerArgs(action) {
    return [worker, action, '--model-dir', this.config.modelDir, '--device', this.config.device];
  }

  async checkSetup() {
    const info = { media: 'speech', model, modelVersion, speakers: [] };
    try {
      if (!this.configured && !(await stat(this.config.modelDir).catch(error => {
        if (error.code !== 'ENOENT') throw error;
      }))?.isDirectory()) {
        return { ...info, status: 'unconfigured', reason: 'Use download_models with media=speech, or run speech-setup with an existing Kokoro model directory.' };
      }
      const { stdout } = await run(this.config.python, this.workerArgs('check'), { timeout: 30_000 });
      const setup = JSON.parse(stdout.trim().split(/\r?\n/).at(-1));
      return { ...info, ...setup };
    } catch {
      return { ...info, status: 'unavailable', reason: 'Could not run the speech setup check. Review the configured Python environment and device.' };
    }
  }

  directory(id) {
    if (!isSpeechJob(id)) throw new Error('Provide a Happy Latent speech job ID.');
    return join(this.jobs, id);
  }

  async generate({ requestId, text, speaker, speed = 1 }) {
    const request = { text, speaker, speed };
    const metadata = { model, modelVersion, speaker, speed };
    // Keep completed speech jobs from earlier profiles accessible by their original IDs.
    const id = 'speech-' + createHash('sha256').update(JSON.stringify([model, modelVersion, requestId])).digest('hex').slice(0, 32);
    const digest = createHash('sha256').update(JSON.stringify(request)).digest('hex');
    const directory = this.directory(id);
    const existing = async () => {
      const job = await readJson(join(directory, 'request.json'));
      if (!job) return null;
      if (job.digest !== digest) throw new Error('This requestId is already bound to another speech request. Use a new requestId for a new line.');
      return this.getJob(id);
    };
    const previous = await existing();
    if (previous) return previous;

    const setup = await this.checkSetup();
    if (setup.status !== 'ready') throw new Error(setup.reason ?? 'Finish local speech setup first.');
    if (!setup.speakers.includes(speaker)) {
      throw new Error(`Kokoro voice "${speaker}" is unavailable. Installed voices ready to use: ${setup.speakers.join(', ')}.`);
    }
    const job = { ...request, id, requestId, digest, metadata, createdAt: new Date().toISOString() };
    await mkdir(this.jobs, { recursive: true, mode: 0o700 });
    const staging = await mkdtemp(join(this.jobs, 'prepare-'));
    try {
      await writeFile(join(staging, 'request.json'), JSON.stringify(job), { mode: 0o600 });
      try {
        await rename(staging, directory);
      } catch (error) {
        if (!['EEXIST', 'ENOTEMPTY'].includes(error.code)) throw error;
        return existing();
      }
    } finally {
      await rm(staging, { recursive: true, force: true });
    }

    const child = execFile(this.config.python, [
      ...this.workerArgs('generate'), '--request', join(directory, 'request.json'),
      '--output', join(directory, 'speech.wav'), '--lock', join(this.jobs, 'worker.lock'),
    ], { timeout: jobTimeout, killSignal: 'SIGKILL' }, (error) => {
      if (error) {
        const reason = error.killed ? 'The local speech worker timed out.' :
          'The local speech worker failed. Check the configured device, Python dependencies, and local model files.';
        void writeFile(join(directory, 'failure.txt'), reason, { mode: 0o600 }).catch(() => {});
      }
    });
    if (child.pid) {
      const stagingPid = join(directory, 'pid.tmp');
      await writeFile(stagingPid, JSON.stringify(child.pid), { mode: 0o600 });
      await rename(stagingPid, join(directory, 'pid.json'));
    }
    return { id, requestId, metadata, createdAt: job.createdAt, media: 'speech', status: 'queued' };
  }

  async getJob(id) {
    const directory = this.directory(id);
    const job = await readJson(join(directory, 'request.json'));
    if (!job) throw new Error(`No Happy Latent speech job found for ${id}.`);
    const { requestId, createdAt, metadata } = job;
    const summary = { id, requestId, createdAt, metadata, text: job.text, media: 'speech' };
    if (await waveInfo(join(directory, 'speech.wav'))) return { ...summary, status: 'completed' };
    let failure;
    try { failure = await readFile(join(directory, 'failure.txt'), 'utf8'); }
    catch (error) { if (error.code !== 'ENOENT') throw error; }
    if (failure) return { ...summary, status: 'failed', reason: failure };
    const age = Date.now() - Date.parse(createdAt);
    const pid = await readJson(join(directory, 'pid.json'));
    if (age < jobTimeout && workerRunning(pid)) return { ...summary, status: 'running' };
    if (age < startupTimeout) return { ...summary, status: 'queued' };
    return { ...summary, status: 'failed', reason: 'The local speech worker stopped before producing audio.' };
  }

  async getResult(id) {
    const job = await this.getJob(id);
    if (job.status !== 'completed') throw new Error(`Speech job ${id} is ${job.status}.`);
    const path = join(this.directory(id), 'speech.wav');
    const info = await waveInfo(path);
    if (!info) throw new Error('The generated speech file is missing.');
    return { jobId: id, path, mediaType: 'audio/wav', ...info, text: job.text, metadata: job.metadata };
  }
}
