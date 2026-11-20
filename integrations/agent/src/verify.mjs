import { execFile } from 'node:child_process';
import { createHash, randomUUID } from 'node:crypto';
import { mkdir, open, readFile, realpath, rename, rm, stat, statfs, writeFile } from 'node:fs/promises';
import { createRequire } from 'node:module';
import { arch, platform, totalmem } from 'node:os';
import { dirname, isAbsolute, join, relative, sep } from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import { fileURLToPath } from 'node:url';
import { promisify } from 'node:util';
import { cloudSelectionPath } from './cloud-state.mjs';

const execute = promisify(execFile);
const require = createRequire(import.meta.url);
const cli = fileURLToPath(new URL('../cli.mjs', import.meta.url));
const defaultRequestId = 'installation-smoke-v1';
const smokeProject = {
  title: 'Happy Latent installation verification', width: 256, height: 256, fps: 24, seed: 42,
  samplingPreset: 'distilled',
  scenes: [{ prompt: 'A red ball rolls slowly across a wooden table in soft daylight. Static camera.',
    durationFrames: 24, audioMode: 'silent' }],
};

async function optionalJson(path) {
  try { return JSON.parse(await readFile(path, 'utf8')); }
  catch (error) { if (error.code !== 'ENOENT') throw error; return undefined; }
}

async function saveJson(path, value) {
  await mkdir(dirname(path), { recursive: true, mode: 0o700 });
  const temporary = `${path}.${randomUUID()}.tmp`;
  try {
    await writeFile(temporary, JSON.stringify(value, null, 2) + '\n', { flag: 'wx', mode: 0o600 });
    await rename(temporary, path);
  } finally { await rm(temporary, { force: true }); }
}

async function binaryVersion(name) {
  try {
    const { stdout } = await execute(name, ['-version'], { timeout: 5000, maxBuffer: 128 * 1024 });
    return { name, status: 'passed', detail: stdout.split('\n')[0] };
  } catch (error) {
    return { name, status: 'optional_missing', detail: error.code === 'ENOENT'
      ? `${name} is not on the MCP process PATH. Install FFmpeg for output inspection.`
      : `${name} could not run (${error.code ?? 'unknown error'}).` };
  }
}

function setupNextSteps(setup, config) {
  if (setup.status === 'ready') return [];
  if (setup.status === 'missing_models') return [
    'Ask Happy Latent to check model access in chat and use download_models for the missing video weights.',
  ];
  if (setup.status === 'missing_nodes') return [
    'Run setup --comfy-root PATH for your ComfyUI checkout, then restart that ComfyUI installation and rerun verify.',
  ];
  return [config.runtime?.managed
    ? 'Run ./integrations/agent/install.sh verify to start the installed managed backend, or ./integrations/agent/install.sh start to inspect startup errors and its log.'
    : 'Start your configured ComfyUI, or run setup --managed on Apple Silicon to provision a dedicated backend.'];
}

async function localSelection(config) {
  const active = await optionalJson(cloudSelectionPath(config));
  return !active;
}

/** Read-only dependency and local backend checks. Does not start ComfyUI or render. */
export async function doctor(config) {
  const checks = [{ name: 'node', status: Number(process.versions.node.split('.')[0]) >= 22 ? 'passed' : 'failed',
    detail: process.version, executable: process.execPath }];
  for (const dependency of ['@modelcontextprotocol/sdk/client/index.js', 'zod/v4']) {
    try { require.resolve(dependency); checks.push({ name: dependency, status: 'passed' }); }
    catch { checks.push({ name: dependency, status: 'failed', detail: 'Run ./integrations/agent/install.sh setup to install locked JavaScript dependencies.' }); }
  }
  checks.push(...await Promise.all(['ffmpeg', 'ffprobe'].map(binaryVersion)));
  const nextSteps = [];
  let setup;
  if (checks.some(check => check.status === 'failed')) {
    nextSteps.push('Run ./integrations/agent/install.sh setup to repair the local Node.js dependencies.');
  } else {
    const { Comfy } = await import('./comfy.mjs');
    setup = await new Comfy({ comfyUrl: config.comfyUrl, dataDir: config.stateDir, assetRoot: config.workspaceDir }).checkSetup();
    checks.push({ name: 'local_comfyui', status: setup.status === 'ready' ? 'passed' : 'failed', detail: setup.status });
    nextSteps.push(...setupNextSteps(setup, config));
  }
  const local = await localSelection(config);
  if (!local) nextSteps.push('A cloud target is selected. Explicitly use disconnect_cloud with useLocal=true before local verification.');
  let disk;
  let path = config.stateDir;
  while (path) {
    try { const info = await statfs(path); disk = { path, availableBytes: info.bavail * info.bsize }; break; }
    catch (error) { if (error.code !== 'ENOENT') break; const parent = dirname(path); if (parent === path) break; path = parent; }
  }
  return { ok: checks.every(check => check.status !== 'failed'), status: setup?.status ?? 'dependency_error',
    readOnly: true, selectedTarget: local ? 'local' : 'cloud', comfyUrl: config.comfyUrl,
    workspaceDir: config.workspaceDir, hardware: { platform: platform(), arch: arch(), memoryBytes: totalmem() },
    ...(disk ? { disk } : {}), checks, ...(setup ? { setup } : {}), nextSteps };
}

async function inspectVideo(result, config) {
  const root = await realpath(join(config.stateDir, 'results'));
  const path = await realpath(result.path);
  const contained = relative(root, path);
  if (!contained || isAbsolute(contained) || contained === '..' || contained.startsWith(`..${sep}`)) {
    throw new Error('Verification output is outside the Happy Latent results folder.');
  }
  const info = await stat(path);
  if (!info.isFile() || info.size < 24) throw new Error('Verification did not produce a nonempty MP4.');
  const checks = [{ name: 'video_file', status: 'passed', path, bytes: info.size }];
  const probe = await binaryVersion('ffprobe');
  if (probe.status === 'passed') {
    const { stdout } = await execute('ffprobe', ['-v', 'error', '-count_frames', '-show_streams', '-show_format', '-of', 'json', path],
      { timeout: 30_000, maxBuffer: 1024 * 1024 });
    const metadata = JSON.parse(stdout);
    const video = metadata.streams?.find(stream => stream.codec_type === 'video');
    const [numerator, denominator = 1] = String(video?.avg_frame_rate ?? '0').split('/').map(Number);
    const fps = numerator / denominator;
    const duration = Number(video?.duration ?? metadata.format?.duration);
    if (!video || video.width !== 256 || video.height !== 256 || Math.abs(fps - 24) > 0.01 ||
        !Number.isFinite(duration) || Math.abs(duration - 1) > 1 / 24 || Number(video.nb_read_frames) !== 24) {
      throw new Error('Generated smoke video does not match 256×256, 24 frames, 24 fps and one second.');
    }
    checks.push({ name: 'video_metadata', status: 'passed', width: video.width, height: video.height, fps, frames: 24, duration });
  } else checks.push({ name: 'video_metadata', status: 'skipped', detail: probe.detail });
  const decoder = await binaryVersion('ffmpeg');
  if (decoder.status === 'passed') {
    await execute('ffmpeg', ['-v', 'error', '-xerror', '-i', path, '-map', '0:v:0', '-f', 'null', '-'],
      { timeout: 30_000, maxBuffer: 1024 * 1024 });
    checks.push({ name: 'video_decode', status: 'passed' });
  } else checks.push({ name: 'video_decode', status: 'skipped', detail: decoder.detail });
  return checks;
}

/** Prove stdio tool access; only render when generate is explicitly true. */
export async function verifyInstallation(config, {
  generate = false, timeoutMs = 15 * 60_000, pollIntervalMs = 1000, requestId = defaultRequestId,
} = {}) {
  if (!Number.isFinite(timeoutMs) || timeoutMs < 1 || timeoutMs > 24 * 60 * 60_000) throw new Error('Verification timeout must be between 1 ms and 24 hours.');
  if (!Number.isFinite(pollIntervalMs) || pollIntervalMs < 1) throw new Error('Verification polling interval must be positive.');
  if (typeof requestId !== 'string' || !requestId.trim() || requestId.length > 128) throw new Error('Verification requestId must contain 1–128 characters.');
  const report = { ok: false, status: 'checking', generated: false, requestId, checks: [], nextSteps: [] };
  const directory = join(config.stateDir, 'verification');
  const key = createHash('sha256').update(JSON.stringify([config.comfyUrl, requestId])).digest('hex');
  const manifestPath = join(directory, `${key}.json`);
  const reportPath = join(directory, 'latest.json');
  let client, transport, lock;
  let manifest;
  try {
    if (!await localSelection(config)) {
      report.status = 'cloud_selected';
      report.nextSteps.push('Explicitly use disconnect_cloud with useLocal=true before local verification. No cloud job was submitted.');
      return report;
    }
    const [{ Client }, { StdioClientTransport }] = await Promise.all([
      import('@modelcontextprotocol/sdk/client/index.js'), import('@modelcontextprotocol/sdk/client/stdio.js'),
    ]);
    client = new Client({ name: 'happylatent-install-verifier', version: '1.0.0' });
    // Passing even the same URL explicitly disables managed-runtime ownership in
    // readConfig. Preserve saved lifecycle settings, while supporting unsaved
    // caller configs (including an isolated verification fixture).
    const saved = await optionalJson(join(config.stateDir, 'config.json'));
    const connectionArgs = saved?.comfyUrl === config.comfyUrl ? [] : ['--comfy-url', config.comfyUrl];
    transport = new StdioClientTransport({ command: process.execPath,
      args: [cli, 'serve', '--state-dir', config.stateDir, ...connectionArgs,
        '--workspace', config.workspaceDir, '--local-only'],
      env: config.runtimeProfile ? { HAPPYLATENT_RUNTIME_PROFILE: config.runtimeProfile } : undefined, stderr: 'pipe' });
    transport.stderr?.resume();
    await client.connect(transport, { timeout: 30_000 });
    const call = async (name, args = {}, timeout = 120_000) => {
      const result = await client.callTool({ name, arguments: args }, undefined, { timeout });
      if (result.isError) throw new Error(`${name}: ${result.content?.filter(item => item.type === 'text').map(item => item.text).join('\n') ?? 'tool failed'}`);
      return result.structuredContent ?? JSON.parse(result.content.find(item => item.type === 'text').text);
    };
    const { tools } = await client.listTools();
    for (const name of ['check_setup', 'cloud_status', 'create_project', 'validate_project', 'generate_video', 'get_job', 'get_result']) {
      if (!tools.some(tool => tool.name === name)) throw new Error(`MCP does not advertise ${name}.`);
    }
    report.checks.push({ name: 'mcp_stdio', status: 'passed', server: client.getServerVersion(), toolCount: tools.length });
    const selected = await call('cloud_status');
    if (selected.target !== 'local') throw new Error('Local verification refuses to use a selected cloud runtime.');
    const setup = await call('check_setup', { media: 'video' });
    report.setup = setup;
    report.checks.push({ name: 'local_comfyui', status: setup.status === 'ready' ? 'passed' : 'failed', detail: setup.status });
    if (setup.status !== 'ready') {
      report.status = setup.status;
      report.nextSteps.push(...setupNextSteps(setup, config));
      return report;
    }
    if (!generate) {
      report.ok = true; report.status = 'ready';
      report.nextSteps.push('Run verify --generate to render and retrieve a one-second 256×256 test video. Readiness alone does not prove GPU generation.');
      return report;
    }
    await mkdir(directory, { recursive: true, mode: 0o700 });
    try { lock = await open(`${manifestPath}.lock`, 'wx', 0o600); }
    catch (error) {
      if (error.code !== 'EEXIST') throw error;
      throw new Error(`This verification request is already running. If it has stopped, remove ${manifestPath}.lock and retry with the same request ID.`);
    }
    await lock.writeFile(String(process.pid));
    manifest = await optionalJson(manifestPath);
    if (!manifest) {
      const snapshot = await call('create_project', smokeProject);
      manifest = { version: 1, requestId, comfyUrl: config.comfyUrl, projectId: snapshot.project.id,
        revision: snapshot.revision, createdAt: new Date().toISOString() };
      await saveJson(manifestPath, manifest);
    }
    report.generation = { ...manifest };
    const validation = await call('validate_project', { projectId: manifest.projectId, revision: manifest.revision });
    if (!validation.ready) throw new Error('The smoke project failed readiness validation.');
    report.checks.push({ name: 'project_validation', status: 'passed' });
    const deadline = Date.now() + timeoutMs;
    let job = manifest.jobId
      ? await call('get_job', { jobId: manifest.jobId })
      : await call('generate_video', { projectId: manifest.projectId, revision: manifest.revision, requestId });
    manifest.jobId = job.id;
    if (typeof manifest.jobId !== 'string') throw new Error('Generation did not return a job ID.');
    await saveJson(manifestPath, manifest);
    report.generation = { ...manifest, job };
    while (['queued', 'running'].includes(job.status) && Date.now() < deadline) {
      await delay(Math.min(pollIntervalMs, Math.max(1, deadline - Date.now())));
      job = await call('get_job', { jobId: manifest.jobId }, Math.max(1000, Math.min(30_000, deadline - Date.now())));
      report.generation.job = job;
    }
    if (job.status !== 'completed') {
      report.status = ['queued', 'running'].includes(job.status) ? 'timed_out' : job.status;
      report.nextSteps.push(`Follow job ${manifest.jobId} with get_job, or rerun verify --generate with the same request ID to resume. The existing job was not cancelled or resubmitted.`);
      return report;
    }
    const result = await call('get_result', { jobId: manifest.jobId }, 240_000);
    report.generation.result = result;
    report.generated = true;
    const outputChecks = await inspectVideo(result, config);
    report.checks.push(...outputChecks);
    report.ok = true;
    report.status = outputChecks.every(check => check.status === 'passed') ? 'verified' : 'generated';
    if (report.status === 'generated') {
      report.nextSteps.push('The MP4 was generated and retrieved. Install FFmpeg/ffprobe and rerun with the same request ID to finish output metadata and decode checks without rendering again.');
    }
    return report;
  } catch (error) {
    report.status = 'failed'; report.error = error.message;
    if (manifest) report.generation = { ...manifest, ...report.generation };
    report.nextSteps.push(manifest
      ? 'Rerun verification with the same request ID after resolving the error; it reuses the saved project and submission.'
      : 'Resolve the reported error, run doctor for local dependency checks, and rerun verify.');
    return report;
  } finally {
    await client?.close().catch(() => {});
    await transport?.close().catch(() => {});
    if (lock) { await lock.close(); await rm(`${manifestPath}.lock`, { force: true }); }
    report.checkedAt = new Date().toISOString();
    report.reportPath = reportPath;
    await saveJson(reportPath, report);
  }
}
