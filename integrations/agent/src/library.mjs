import { musicResult, verifyMusicAudio } from './music.mjs';
import { checkedCloudAsset, cloudDataHash } from './cloud-data.mjs';
import { execFile } from 'node:child_process';
import { createHash } from 'node:crypto';
import { constants } from 'node:fs';
import { lstat, mkdir, mkdtemp, open, readdir, realpath, rm } from 'node:fs/promises';
import { isAbsolute, join, relative, resolve } from 'node:path';
import { promisify } from 'node:util';
import { readProject } from '../resources/project-core/domain.js';
import { validateSceneMemory } from './scene-memory.mjs';

const exec = promisify(execFile);
const UUID = /^[a-f0-9]{8}(?:-[a-f0-9]{4}){3}-[a-f0-9]{12}$/;
const SPEECH_ID = /^speech-[a-f0-9]{32}$/;
const REVISION = /^[1-9][0-9]*\.json$/;
const STATES = new Set(['queued', 'running', 'submitting', 'completed', 'failed', 'cancelled', 'unknown']);
const TERMINAL = new Set(['completed', 'failed', 'cancelled']);
const MAX_JSON = 8 * 1024 * 1024;
const text = (value, max = 200) => typeof value === 'string' ? value.slice(0, max) : '';
const timestamp = (value, fallback) => typeof value === 'string' && Number.isFinite(Date.parse(value)) ? new Date(value).toISOString() : fallback;
const contains = (values, query) => !query || values.some(value => String(value ?? '').toLowerCase().includes(query));
const same = (left, right) => JSON.stringify(left) === JSON.stringify(right);

function options(input, fields) {
  const { limit = 20, cursor, query = '' } = input;
  if (!Number.isInteger(limit) || limit < 1 || limit > 100) throw new Error('Use a limit from 1 to 100.');
  if (typeof query !== 'string' || query.length > 500) throw new Error('Search query must be at most 500 characters.');
  if (cursor !== undefined && (typeof cursor !== 'string' || cursor.length > 2048)) throw new Error('Invalid library cursor.');
  const scope = createHash('sha256').update(JSON.stringify(fields)).digest('hex').slice(0, 24);
  let after;
  if (cursor) {
    try {
      const decoded = JSON.parse(Buffer.from(cursor, 'base64url').toString('utf8'));
      if (decoded.version !== 1 || decoded.scope !== scope || !Array.isArray(decoded.after) || decoded.after.length !== 2 ||
          typeof decoded.after[0] !== 'number' || !Number.isFinite(decoded.after[0]) || typeof decoded.after[1] !== 'string') throw new Error();
      after = decoded.after;
    } catch { throw new Error('Invalid library cursor or filters changed. Start a new search.'); }
  }
  return { limit, query: query.trim().toLowerCase(), scope, after };
}

function paginate(records, { limit, after, scope }, key) {
  const ordered = records.sort((left, right) => {
    const a = key(left), b = key(right);
    return b[0] - a[0] || b[1].localeCompare(a[1]);
  });
  const remaining = after ? ordered.filter(item => {
    const current = key(item);
    return current[0] < after[0] || (current[0] === after[0] && current[1].localeCompare(after[1]) < 0);
  }) : ordered;
  const items = remaining.slice(0, limit);
  const nextCursor = remaining.length > items.length ? Buffer.from(JSON.stringify({ version: 1, scope, after: key(items.at(-1)) })).toString('base64url') : null;
  return { items, total: records.length, nextCursor };
}

function changes(previous, current, previousMemory = {}, currentMemory = {}) {
  const memoryChangedSceneIds = [...new Set([...Object.keys(previousMemory), ...Object.keys(currentMemory)])]
    .filter(id => !same(previousMemory[id], currentMemory[id]));
  if (!previous) return { type: 'initial', addedSceneIds: current.scenes.map(scene => scene.id), memoryChangedSceneIds };
  const before = new Map(previous.scenes.map(scene => [scene.id, scene]));
  const after = new Map(current.scenes.map(scene => [scene.id, scene]));
  const settings = [...new Set([...Object.keys(previous), ...Object.keys(current)])]
    .filter(key => !['scenes', 'audioSegments', 'id', 'version'].includes(key) && !same(previous[key], current[key]));
  return {
    type: 'edit', changedSettings: settings, memoryChangedSceneIds,
    addedSceneIds: current.scenes.filter(scene => !before.has(scene.id)).map(scene => scene.id),
    removedSceneIds: previous.scenes.filter(scene => !after.has(scene.id)).map(scene => scene.id),
    updatedSceneIds: current.scenes.filter(scene => before.has(scene.id) && !same(scene, before.get(scene.id))).map(scene => scene.id),
    sceneOrderChanged: !same(previous.scenes.filter(scene => after.has(scene.id)).map(scene => scene.id), current.scenes.filter(scene => before.has(scene.id)).map(scene => scene.id)),
    audioChanged: !same(previous.audioSegments, current.audioSegments),
    musicChanged: !same(previous.musicSegments ?? [], current.musicSegments ?? []),
  };
}

/** Reads only owned, persisted records. No ComfyUI connection or runtime startup. */
export class Library {
  constructor({ stateDir }) { this.stateDir = resolve(stateDir); }

  async safePath(path, kind = 'file') {
    const stat = await lstat(path);
    if (stat.isSymbolicLink() || (kind === 'file' ? !stat.isFile() : !stat.isDirectory())) throw new Error('Library entries must be regular owned files or directories.');
    const [root, actual] = await Promise.all([realpath(this.stateDir), realpath(path)]);
    const rel = relative(root, actual);
    if (rel === '..' || rel.startsWith('..' + (process.platform === 'win32' ? '\\' : '/')) || isAbsolute(rel)) throw new Error('Library entry is outside the agent state directory.');
    return { path: actual, stat };
  }

  async read(path, optional = false) {
    let handle;
    try {
      const source = await this.safePath(path);
      handle = await open(source.path, constants.O_RDONLY | constants.O_NONBLOCK | (constants.O_NOFOLLOW ?? 0));
      const stat = await handle.stat();
      if (!stat.isFile() || stat.size > MAX_JSON) throw new Error('Invalid or oversized library record.');
      return { data: JSON.parse(await handle.readFile('utf8')), stat };
    } catch (error) {
      if (optional && error.code === 'ENOENT') return null;
      throw error;
    } finally { await handle?.close(); }
  }

  async directories(name, pattern) {
    try {
      const root = await this.safePath(join(this.stateDir, name), 'directory');
      const entries = await readdir(root.path, { withFileTypes: true });
      return entries.filter(entry => entry.isDirectory() && pattern.test(entry.name)).map(entry => entry.name);
    } catch (error) { if (error.code === 'ENOENT') return []; throw error; }
  }

  async projectSnapshots(projectId) {
    if (!UUID.test(projectId)) throw new Error('Invalid project ID.');
    const source = await this.safePath(join(this.stateDir, 'projects', projectId), 'directory');
    const entries = await readdir(source.path, { withFileTypes: true });
    const numbers = entries.filter(entry => entry.isFile() && REVISION.test(entry.name)).map(entry => Number(entry.name.slice(0, -5))).filter(Number.isSafeInteger).sort((a, b) => a - b);
    const snapshots = []; let skipped = 0;
    for (const revision of numbers) {
      try {
        const { data, stat } = await this.read(join(source.path, `${revision}.json`));
        if (data.projectId !== projectId || data.project?.id !== projectId || data.revision !== revision) throw new Error('Mismatched project identifiers.');
        const project = readProject(data.project);
        const sceneMemory = validateSceneMemory(project, data.sceneMemory);
        snapshots.push({ project, sceneMemory, revision, savedAt: timestamp(data.savedAt, stat.mtime.toISOString()) });
      } catch { skipped++; }
    }
    return { snapshots, skipped, latestStoredRevision: numbers.at(-1) ?? null };
  }

  projectSummary(projectId, snapshot) {
    const { project, revision, savedAt } = snapshot;
    const frames = project.scenes.reduce((sum, scene) => sum + scene.durationFrames, 0);
    return { projectId, title: project.title, revision, savedAt, sceneCount: project.scenes.length, durationSeconds: frames / project.fps, width: project.width, height: project.height, fps: project.fps };
  }

  async listProjects(input = {}) {
    const opts = options(input, ['projects', input.query?.trim().toLowerCase() ?? '']);
    const records = []; let skippedRecords = 0;
    for (const projectId of await this.directories('projects', UUID)) {
      try {
        const { snapshots, skipped, latestStoredRevision } = await this.projectSnapshots(projectId);
        skippedRecords += skipped;
        const latest = snapshots.at(-1);
        if (!latest) { if (!skipped) skippedRecords++; continue; }
        const memoryText = Object.values(latest.sceneMemory).flatMap(binding =>
          [...binding.characters, ...(binding.location ? [binding.location] : [])].flatMap(entry => [entry.name, entry.description]));
        if (!contains([latest.project.title, projectId, latest.project.globalPrompt,
          ...latest.project.scenes.flatMap(scene => [scene.name, scene.prompt]), ...memoryText], opts.query)) continue;
        records.push({ ...this.projectSummary(projectId, latest), createdAt: snapshots[0].savedAt, revisionCount: snapshots.length, latestStoredRevision });
      } catch { skippedRecords++; }
    }
    const jobRecords = [];
    for (const id of await this.directories('jobs', UUID)) {
      try { jobRecords.push(await this.jobSummary(id)); } catch { /* Job corruption is reported by list_jobs. */ }
    }
    jobRecords.sort((a, b) => Date.parse(b.createdAt) - Date.parse(a.createdAt) || b.jobId.localeCompare(a.jobId));
    for (const record of records) {
      const jobs = jobRecords.filter(job => job.projectId === record.projectId);
      const latest = jobs[0], thumbnail = jobs.find(job => job.thumbnailAvailable);
      record.latestJobId = latest?.jobId ?? null;
      record.thumbnailJobId = thumbnail?.jobId ?? null;
      record.thumbnailAvailable = !!thumbnail;
    }
    const page = paginate(records, opts, record => [Date.parse(record.savedAt), record.projectId]);
    return { projects: page.items, total: page.total, nextCursor: page.nextCursor, skippedRecords };
  }

  async listProjectRevisions(input) {
    const opts = options(input, ['revisions', input.projectId]);
    let data;
    try { data = await this.projectSnapshots(input.projectId); }
    catch (error) { if (error.code === 'ENOENT') throw new Error('Project was not found.'); throw error; }
    const records = data.snapshots.map((snapshot, index) => ({
      ...this.projectSummary(input.projectId, snapshot),
      comparedRevision: data.snapshots[index - 1]?.revision ?? null,
      changes: changes(data.snapshots[index - 1]?.project, snapshot.project, data.snapshots[index - 1]?.sceneMemory, snapshot.sceneMemory),
    }));
    const page = paginate(records, opts, record => [record.revision, record.projectId]);
    return { projectId: input.projectId, revisions: page.items, total: page.total, nextCursor: page.nextCursor, skippedRecords: data.skipped, latestStoredRevision: data.latestStoredRevision };
  }

  async cachedResult(id, media) {
    const path = media === 'speech' ? join(this.stateDir, 'speech-jobs', id, 'speech.wav')
      : join(this.stateDir, 'results', media === 'image' ? `${id}-1.png` : media === 'music' ? `${id}.flac` : `${id}.mp4`);
    try {
      const safe = await this.safePath(path);
      return safe.stat.size > 0 ? safe.path : null;
    } catch (error) { if (error.code === 'ENOENT') return null; throw error; }
  }

  async cachedMusicResult(id) {
    if (!UUID.test(id)) return null;
    const file = await this.cachedResult(id, 'music');
    if (!file) return null;
    const dir = join(this.stateDir, 'jobs', id);
    const job = (await this.read(join(dir, 'job.json'), true))?.data;
    if (job?.id !== id || job.media !== 'music') return null;
    const terminal = (await this.read(join(dir, 'terminal.json'), true))?.data;
    if (terminal?.status !== 'completed') return null;
    // A download interrupted before its receipt was written must still go
    // through normal retrieval so shutdown and cleanup can verify the copy.
    if (job.runtimeId) {
      if (!UUID.test(job.runtimeId) || !terminal.outputs?.length) return null;
      const hash = cloudDataHash(checkedCloudAsset(terminal.outputs[0]));
      const receipts = join(this.stateDir, 'cloud', 'data', job.runtimeId);
      const receipt = await this.read(join(receipts, hash + '.json'), true);
      if (receipt) {
        const receivedPath = receipt.data.retrieved?.path;
        if (receivedPath !== file && receivedPath !== join(this.stateDir, 'results', id + '.flac')) return null;
      } else {
        // Cloud cleanup verifies retrieval before replacing transfer receipts with a history deletion record.
        const cleanup = (await this.read(join(receipts, `history-${id}.json`), true))?.data;
        if (cleanup?.deleted !== true || cleanup.runtimeId !== job.runtimeId || cleanup.jobId !== id
            || cleanup.promptId !== (terminal.promptId ?? id)) return null;
      }
    }
    return musicResult(job, file, await verifyMusicAudio(file, job.expected), this.stateDir);
  }

  async jobSummary(id, speech = false) {
    if (!(speech ? SPEECH_ID : UUID).test(id)) throw new Error('Invalid job ID.');
    const directory = await this.safePath(join(this.stateDir, speech ? 'speech-jobs' : 'jobs', id), 'directory');
    const { data: job, stat } = await this.read(join(directory.path, speech ? 'request.json' : 'job.json'));
    if (job.id !== id || (!speech && job.media !== undefined && !['video', 'image', 'music'].includes(job.media))) throw new Error('Invalid saved job.');
    const media = speech ? 'speech' : job.media ?? 'video';
    const resultPath = await this.cachedResult(id, media);
    let status = 'unknown', statusSource = 'unverified-submission', statusUpdatedAt, lastKnownStatus;
    if (speech) {
      if (resultPath) { status = 'completed'; statusSource = 'local-result'; }
      else {
        try {
          await this.safePath(join(directory.path, 'failure.txt'));
          status = 'failed'; statusSource = 'saved-failure';
        } catch (error) { if (error.code !== 'ENOENT') throw error; }
      }
    } else {
      const terminal = await this.read(join(directory.path, 'terminal.json'), true);
      const submission = terminal ? null : await this.read(join(directory.path, 'submission.json'), true);
      if (terminal) {
        if (!TERMINAL.has(terminal.data.status)) throw new Error('Invalid saved terminal status.');
        status = terminal.data.status; statusSource = 'saved-terminal';
      } else if (submission?.data.status === 'failed') {
        status = 'failed'; statusSource = 'saved-submission';
      } else {
        const progress = await this.read(join(directory.path, 'progress.json'), true);
        if (progress && progress.data.jobId === id && progress.data.runtimeId === job.runtimeId) {
          const state = progress.data.state;
          statusUpdatedAt = timestamp(progress.data.lastEventAt, null);
          if (['running', 'completed', 'failed', 'cancelled'].includes(state)) lastKnownStatus = state;
          const age = statusUpdatedAt ? Date.now() - Date.parse(statusUpdatedAt) : Infinity;
          if (state === 'running' && age >= 0 && age <= 60_000) { status = 'running'; statusSource = 'cached-progress'; }
        }
      }
    }
    const expected = {};
    for (const key of ['width', 'height', 'fps', 'frames', 'durationSeconds']) if (Number.isFinite(job.expected?.[key]) && job.expected[key] > 0) expected[key] = job.expected[key];
    const clipManifest = speech ? null : await this.read(join(directory.path, 'clips.json'), true);
    const clips = Array.isArray(clipManifest?.data.clips) ? clipManifest.data.clips : [];
    return {
      _search: [job.text, ...Object.values(job.prompt ?? {}).flatMap(node => Object.entries(node?.inputs ?? {}).filter(([key, value]) => ['prompt', 'text', 'project', 'tags', 'lyrics'].includes(key) && typeof value === 'string').map(([, value]) => value))],
      jobId: id, media, title: text(job.projectTitle || job.requestId || (speech ? job.metadata?.speaker : '') || id),
      ...(job.operation && job.sourceClipId ? { operation: job.operation, sourceClipId: text(job.sourceClipId, 128) } : {}),
      requestId: text(job.requestId, 128), createdAt: timestamp(job.createdAt, stat.mtime.toISOString()),
      ...(UUID.test(job.projectId ?? '') ? { projectId: job.projectId, revision: job.revision } : {}),
      runtime: !speech && job.runtimeId ? 'cloud' : 'local',
      ...(!speech && UUID.test(job.runtimeId ?? '') ? { runtimeId: job.runtimeId } : {}),
      status, statusSource, ...(lastKnownStatus ? { lastKnownStatus, statusUpdatedAt } : {}), cachedResult: !!resultPath,
      ...(status === 'completed' && resultPath ? { thumbnailAvailable: true } : { thumbnailAvailable: false }),
      ...(Object.keys(expected).length ? { expected } : {}),
      ...(job.clips ? { mode: job.mode, scope: job.scope, clipCount: clips.length,
        clips: clips.map(clip => ({ clipId: clip.id, sceneId: clip.sceneId, name: clip.name })) } : {}),
      ...(speech ? { speaker: text(job.metadata?.speaker, 40), speed: job.metadata?.speed } : {}),
    };
  }

  async listJobs(input = {}) {
    const { media, status, projectId, runtime } = input;
    if (media !== undefined && !['video', 'image', 'speech', 'music'].includes(media)) throw new Error('Invalid media filter.');
    if (status !== undefined && !STATES.has(status)) throw new Error('Invalid status filter.');
    if (projectId !== undefined && !UUID.test(projectId)) throw new Error('Invalid project ID.');
    if (runtime !== undefined && !['local', 'cloud'].includes(runtime)) throw new Error('Invalid runtime filter.');
    const opts = options(input, ['jobs', input.query?.trim().toLowerCase() ?? '', media, status, projectId, runtime]);
    const records = []; let skippedRecords = 0;
    for (const [name, pattern, speech] of [['jobs', UUID, false], ['speech-jobs', SPEECH_ID, true]]) {
      if ((media === 'speech' && !speech) || (media && media !== 'speech' && speech)) continue;
      for (const id of await this.directories(name, pattern)) {
        try {
          const record = await this.jobSummary(id, speech);
          if ((media && record.media !== media) || (status && record.status !== status) || (projectId && record.projectId !== projectId) || (runtime && record.runtime !== runtime)) continue;
          if (!contains([record.title, record.requestId, record.jobId, record.speaker, ...record._search], opts.query)) continue;
          records.push(record);
        } catch { skippedRecords++; }
      }
    }
    const page = paginate(records, opts, record => [Date.parse(record.createdAt), record.jobId]);
    return { jobs: page.items.map(({ _search, ...record }) => record), total: page.total, nextCursor: page.nextCursor, skippedRecords,
      statusNote: 'Offline library of saved jobs across runtimes. Nonterminal statuses are cached observations, not a live queue check; stale or absent observations are unknown; use get_job on their runtime for current progress. Results must be fetched with get_result before a thumbnail is available.' };
  }

  async thumbnail({ jobId }) {
    const job = await this.jobSummary(jobId, SPEECH_ID.test(jobId));
    if (job.status !== 'completed' || !job.cachedResult) throw new Error('Fetch a completed job with get_result before requesting its thumbnail.');
    const source = await this.cachedResult(jobId, job.media);
    const input = ['-protocol_whitelist', 'file,pipe', '-i', source];
    let probe;
    try {
      const { stdout } = await exec('ffprobe', ['-v', 'error', ...input, '-show_streams', '-show_format', '-of', 'json'], { timeout: 120000, maxBuffer: 4 * 1024 * 1024 });
      probe = JSON.parse(stdout);
    } catch (error) { throw new Error(error.code === 'ENOENT' ? 'Thumbnails require local ffmpeg and ffprobe on the MCP process PATH.' : 'Unable to inspect the cached media for a thumbnail.'); }
    const video = probe.streams?.find(stream => stream.codec_type === 'video');
    const duration = Number(probe.format?.duration);
    if (!['speech', 'music'].includes(job.media) && (!video || !(video.width > 0 && video.height > 0) || video.width * video.height > 4096 * 4096)) throw new Error('Unsupported thumbnail dimensions.');
    if (job.media !== 'image' && (!(duration > 0) || duration > 1800)) throw new Error('Thumbnails support media up to 30 minutes.');
    const root = join(this.stateDir, 'thumbnails');
    await mkdir(root, { recursive: true, mode: 0o700 });
    await this.safePath(root, 'directory');
    const directory = await mkdtemp(join(root, 'preview-'));
    const destination = join(directory, 'thumbnail.png');
    const timestampSeconds = job.media === 'video' ? Math.min(duration / 2, 1) : undefined;
    const args = ['speech', 'music'].includes(job.media)
      ? [...input, '-filter_complex', '[0:a:0]showwavespic=s=512x144:colors=0x59b8ff[v]', '-map', '[v]', '-frames:v', '1', destination]
      : [...input, ...(timestampSeconds === undefined ? [] : ['-ss', String(timestampSeconds)]), '-map', '0:v:0', '-frames:v', '1', '-vf', 'scale=512:288:force_original_aspect_ratio=decrease,pad=512:288:(ow-iw)/2:(oh-ih)/2', destination];
    try {
      await exec('ffmpeg', ['-hide_banner', '-nostdin', '-v', 'error', '-y', ...args], { timeout: 120000, maxBuffer: 4 * 1024 * 1024 });
      const output = await this.safePath(destination);
      if (!output.stat.size || output.stat.size > 4 * 1024 * 1024) throw new Error('Invalid thumbnail output.');
      return { report: { jobId, media: job.media, title: job.title, thumbnailPath: destination, ...(timestampSeconds === undefined ? {} : { timestampSeconds }), cachedSource: true }, images: [destination] };
    } catch (error) {
      await rm(directory, { recursive: true, force: true });
      throw new Error(error.code === 'ENOENT' ? 'Thumbnails require local ffmpeg and ffprobe on the MCP process PATH.' : 'Unable to create a thumbnail from the cached media.');
    }
  }
}
