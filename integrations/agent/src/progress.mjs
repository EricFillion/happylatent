import { constants } from 'node:fs';
import { link, lstat, open, rename, rm } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { randomUUID } from 'node:crypto';

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
const TERMINAL = new Set(['completed', 'failed', 'cancelled']);
const monitors = new Map();
const inFlight = new Map();
const memberCache = new WeakMap();
const MAX_MONITORS = 32;
const MAX_MESSAGE = 2 * 1024 * 1024;

function seconds(ms) { return Math.max(0, Math.round(ms / 100) / 10); }
function iso(ms) { return new Date(ms).toISOString(); }
function bounded(value, length = 300) { return typeof value === 'string' ? value.slice(0, length) : undefined; }

/** Suggestions only: this module never retries a render or changes its settings. */
export function explainGenerationFailure(reason, nodeType) {
  const message = bounded(reason, 1500) || 'ComfyUI reported a generation error.';
  const text = `${nodeType ?? ''} ${message}`;
  if (/out of memory|outofmemory|allocation.*fail|mps backend out of memory/i.test(text)) {
    return { code: 'out_of_memory', message, recommendation: 'Reduce resolution or scene length, disable optional enhancement stages, or use a runtime with more memory. Submit a new request only after choosing the change.' };
  }
  if (/no such file|file.*not found|missing.*(?:model|checkpoint|weight)|model.*unavailable/i.test(text)) {
    return { code: 'missing_file', message, recommendation: 'Run check_setup and validate_project to identify missing models or media before submitting again.' };
  }
  if (/cuda.*(?:driver|version)|not compiled with cuda|no kernel image|unsupported.*(?:dtype|device)/i.test(text)) {
    return { code: 'runtime_incompatible', message, recommendation: 'Check the GPU runtime and dependency versions with diagnose_setup; keep the failed job ID for diagnosis.' };
  }
  if (/connection|network|timed? ?out|econn|fetch failed/i.test(text)) {
    return { code: 'connection', message, recommendation: 'Reconnect the selected runtime and check the same job ID. Do not submit a duplicate while its outcome is unknown.' };
  }
  return { code: 'generation_failed', message, recommendation: 'Review the reported node error and its inputs. Keep the failed job ID for diagnosis before submitting a new request.' };
}

function membersFor(job) {
  if (memberCache.has(job)) return memberCache.get(job);
  const members = Object.entries(job.prompt ?? {}).flatMap(([id, node]) => {
    if (!['HappyLatentVideo', 'HappyLatentKleinImage'].includes(node.class_type)) return [];
    let scenes = [];
    if (node.class_type === 'HappyLatentVideo') {
      try {
        const project = JSON.parse(node.inputs.project);
        if (Array.isArray(project.scenes)) scenes = project.scenes.slice(0, 100);
      } catch { /* Invalid graph still receives generic progress and error details. */ }
    }
    return [{ id, type: node.class_type, scenes }];
  });
  memberCache.set(job, members);
  return members;
}

/** Map execution IDs, not display IDs (the latter collapse expanded children). */
export function generationStage(job, nodeId) {
  if (typeof nodeId !== 'string' || nodeId.length > 500) return null;
  const direct = job.prompt?.[nodeId];
  if (direct) {
    const type = direct.class_type;
    if (job.operation === 'upscale' && (nodeId === 'upscale' || nodeId === 'upscale_refine')) {
      const sampling = nodeId === 'upscale_refine';
      return { code: 'spatial_upscale', label: sampling ? 'Refining spatial upscale' : 'Applying spatial upscale',
        nodeId, sampling, scene: null };
    }
    const code = /Loader|Checkpoint/.test(type) ? 'loading_models'
      : type === 'SaveVideo' || type === 'SaveImage' ? 'saving_output'
        : type === 'HappyLatentVideo' || type === 'HappyLatentKleinImage' ? 'preparing_generation' : 'preparing_inputs';
    return { code, label: { loading_models: 'Loading models', saving_output: 'Saving output', preparing_generation: 'Preparing generation', preparing_inputs: 'Preparing inputs' }[code], nodeId, sampling: false, scene: null };
  }
  for (const member of membersFor(job)) {
    if (!nodeId.startsWith(`${member.id}.`)) continue;
    const key = /^\d+\.\d+\.(.+)$/.exec(nodeId.slice(member.id.length + 1))?.[1];
    if (!key) continue;
    let scene = null, operation = key;
    if (member.type === 'HappyLatentVideo') {
      const match = /^scene_(\d+)_(.+)$/.exec(key);
      if (match) {
        const index = Number(match[1]);
        if (index >= member.scenes.length) return null;
        const authored = member.scenes[index];
        scene = { index: index + 1, total: member.scenes.length, id: bounded(authored.id, 128), name: bounded(authored.name, 120) ?? `Scene ${index + 1}` };
        operation = match[2];
      }
    }
    const sampling = operation === 'sample' || operation === 'refine' || operation === 'upscale_refine' || /^temporal_window_\d+_sample$/.test(operation);
    let code, label;
    if (operation === 'sequence') [code, label] = ['assembling_video', 'Assembling video'];
    else if (operation === 'soundtrack') [code, label] = ['assembling_audio', 'Assembling audio'];
    else if (operation === 'sample') [code, label] = ['sampling', member.type === 'HappyLatentVideo' ? 'Generating video' : 'Generating image'];
    else if (operation.startsWith('temporal_')) [code, label] = ['temporal_upscale', sampling ? 'Refining temporal upscale' : 'Preparing temporal upscale'];
    else if (operation.startsWith('upscale')) [code, label] = ['spatial_upscale', sampling ? 'Refining spatial upscale' : 'Preparing spatial upscale'];
    else if (operation.startsWith('refine')) [code, label] = ['refinement', sampling ? 'Refining video' : 'Preparing refinement'];
    else if (operation === 'positive' || operation === 'text') [code, label] = ['encoding_prompt', 'Encoding prompt'];
    else if (operation === 'decode') [code, label] = ['decoding', member.type === 'HappyLatentVideo' ? 'Decoding video' : 'Decoding image'];
    else if (operation === 'audio_decode') [code, label] = ['decoding_audio', 'Decoding audio'];
    else if (operation.includes('audio')) [code, label] = ['preparing_audio', 'Preparing audio'];
    else if (/image|crop|frame|reference|encode_\d/.test(operation)) [code, label] = ['preparing_references', 'Preparing reference images'];
    else if (/model|clip|vae/.test(operation)) [code, label] = ['loading_models', 'Loading models'];
    else [code, label] = ['preparing_clip', 'Preparing clip'];
    return { code, label, nodeId, sampling, scene };
  }
  return null;
}

/** Pure reducer; only prompt-scoped observations can advance the snapshot. */
export class GenerationProgress {
  constructor(job, { promptId = job.id, now = Date.now, previous } = {}) {
    this.job = job;
    this.now = now;
    this.samples = [];
    this.snapshot = previous?.jobId === job.id && previous?.promptId === promptId && previous?.runtimeId === job.runtimeId
      ? structuredClone(previous)
      : { version: 1, jobId: job.id, promptId, ...(job.runtimeId === undefined ? {} : { runtimeId: job.runtimeId }),
          state: 'waiting', connection: 'connecting', startedAt: null, lastEventAt: null, updatedAt: iso(now()),
          stage: null, scene: null, sampling: null, estimatedRemainingSeconds: null,
          estimateNote: 'Whole-render ETA is unavailable. Sampling estimates, when present, apply only to the current stage.' };
  }

  setPromptId(promptId) {
    if (!UUID.test(promptId)) return;
    this.snapshot.promptId = promptId;
  }

  connection(value) {
    this.snapshot.connection = value;
    this.snapshot.updatedAt = iso(this.now());
    if (value !== 'live') {
      if (!TERMINAL.has(this.snapshot.state) && this.snapshot.startedAt && this.snapshot.timing) this.snapshot.timing.interrupted = true;
      this.samples = [];
      if (this.snapshot.sampling) this.snapshot.sampling.estimatedRemainingSeconds = null;
    }
  }

  show(nodeId, value, max, actual = false) {
    const stage = generationStage(this.job, nodeId);
    if (!stage) return false;
    // A parent remains running while its expanded children run.
    if (this.job.prompt?.[nodeId]?.class_type?.startsWith('HappyLatent') && this.snapshot.stage?.nodeId?.startsWith(`${nodeId}.`)) return false;
    const same = this.snapshot.stage?.nodeId === nodeId;
    if (!same) this.samples = [];
    if (!same && this.snapshot.timing && !this.snapshot.timing.interrupted) {
      this.recordStageTime();
      this.snapshot.timing.stageAt = this.now();
    }
    if (actual && value > 0 && this.snapshot.timing && stage.sampling) {
      if (stage.code === 'sampling') this.snapshot.timing.sampled = true;
      if (stage.code === 'spatial_upscale') this.snapshot.timing.refined = true;
    }
    this.snapshot.stage = { code: stage.code, label: stage.label, nodeId };
    this.snapshot.scene = stage.scene;
    if (!same || !stage.sampling) this.snapshot.sampling = null;
    if (stage.sampling && Number.isInteger(value) && Number.isInteger(max) && max > 0 && value >= 0 && value <= max && (actual || value > 0)) {
      const previous = this.samples.at(-1);
      if (!previous || value > previous.value) {
        this.samples.push({ at: this.now(), value, max });
        this.samples = this.samples.slice(-8);
      } else if (value < previous.value || max !== previous.max) this.samples = [{ at: this.now(), value, max }];
      const first = this.samples[0], last = this.samples.at(-1);
      const canEstimate = this.samples.length >= 3 && last.at - first.at >= 1000 && last.value > first.value;
      this.snapshot.sampling = { completed: value, total: max, percent: Math.round(value / max * 1000) / 10,
        scope: 'current_sampling_stage', estimatedRemainingSeconds: value === max ? 0 : canEstimate ? seconds((last.at - first.at) / (last.value - first.value) * (max - value)) : null };
    }
    return true;
  }

  recordStageTime() {
    const timing = this.snapshot.timing;
    if (!timing || timing.interrupted || !Number.isFinite(timing.stageAt)) return;
    if (['spatial_upscale', 'refinement'].includes(this.snapshot.stage?.code)) {
      timing.refinementMs += Math.max(0, this.now() - timing.stageAt);
    }
    timing.stageAt = undefined;
  }

  receive(type, data) {
    if (!data || data.prompt_id !== this.snapshot.promptId || TERMINAL.has(this.snapshot.state)) return false;
    const now = this.now();
    let changed = false;
    if (type === 'execution_start') {
      if (!this.snapshot.startedAt) {
        this.snapshot.startedAt = iso(now);
        this.snapshot.timing = { refinementMs: 0 };
      }
      changed = true;
    } else if (type === 'execution_success' || type === 'execution_error' || type === 'execution_interrupted') {
      const state = type === 'execution_success' ? 'completed' : type === 'execution_error' ? 'failed' : 'cancelled';
      if (state === 'completed' && this.snapshot.timing) {
        this.recordStageTime();
        this.snapshot.timing.completedOnSocket = true;
      }
      this.finish(state, type === 'execution_error' ? data.exception_message : undefined, data.node_type);
      changed = true;
    } else if (type === 'progress_state' && data.nodes && typeof data.nodes === 'object') {
      const running = Object.entries(data.nodes).filter(([node, value]) => value?.state === 'running' && generationStage(this.job, node));
      const current = running.filter(([node]) => !this.job.prompt?.[node]).at(-1) ?? running.at(-1);
      if (current) changed = this.show(current[0], current[1].value, current[1].max);
    } else if (type === 'progress') {
      changed = this.show(data.node, data.value, data.max, true);
    } else if (type === 'executing' && data.node !== null) {
      changed = this.show(data.node);
    } else if (type === 'executed' && generationStage(this.job, data.node)?.code === 'saving_output') {
      changed = this.show(data.node);
    }
    if (!changed) return false;
    if (!TERMINAL.has(this.snapshot.state)) this.snapshot.state = 'running';
    this.snapshot.lastEventAt = iso(now);
    this.snapshot.updatedAt = iso(now);
    this.snapshot.connection = 'live';
    return true;
  }

  finish(state, reason, nodeType) {
    if (!TERMINAL.has(state)) return;
    this.snapshot.state = state;
    this.snapshot.finishedAt ??= iso(this.now());
    this.snapshot.updatedAt = iso(this.now());
    if (state === 'failed') this.snapshot.failure = explainGenerationFailure(reason, nodeType);
    if (this.snapshot.sampling) this.snapshot.sampling.estimatedRemainingSeconds = null;
  }

  report() {
    const snapshot = structuredClone(this.snapshot);
    const end = snapshot.finishedAt ? Date.parse(snapshot.finishedAt) : this.now();
    snapshot.elapsedSeconds = snapshot.startedAt ? seconds(end - Date.parse(snapshot.startedAt)) : null;
    snapshot.observationAgeSeconds = snapshot.lastEventAt ? seconds(this.now() - Date.parse(snapshot.lastEventAt)) : null;
    return snapshot;
  }
}

function paths(dataDir, id) {
  if (!UUID.test(id)) throw new Error('Progress requires an owned Happy Latent job UUID.');
  const root = resolve(dataDir), directory = join(root, 'jobs', id);
  return { root, directory, snapshot: join(directory, 'progress.json'), owner: join(directory, 'progress-owner.json') };
}

async function regularJson(file) {
  let handle;
  try {
    handle = await open(file, constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0) | (constants.O_NONBLOCK ?? 0));
    const info = await handle.stat();
    if (!info.isFile() || info.size > MAX_MESSAGE) return null;
    return JSON.parse(await handle.readFile('utf8'));
  } catch (error) {
    if (['ENOENT', 'ELOOP'].includes(error.code) || error instanceof SyntaxError) return null;
    throw error;
  } finally { await handle?.close(); }
}

async function safeDirectory(p) {
  for (const directory of [join(p.root, 'jobs'), p.directory]) {
    const info = await lstat(directory);
    if (!info.isDirectory() || info.isSymbolicLink()) throw new Error('Progress storage must use regular owned job directories.');
  }
}

export async function readJobProgress(dataDir, job) {
  const p = paths(dataDir, job.id);
  // Events in this process have already updated the reducer; wait for those
  // queued writes so a read does not return an older on-disk observation.
  await monitors.get(p.directory)?.writeChain.catch(() => {});
  try { await safeDirectory(p); } catch (error) { if (error.code === 'ENOENT') return null; throw error; }
  const saved = await regularJson(p.snapshot);
  if (saved?.version !== 1 || saved?.jobId !== job.id || saved?.runtimeId !== job.runtimeId || !UUID.test(saved.promptId)) return null;
  const reducer = new GenerationProgress(job, { promptId: saved.promptId, previous: saved });
  if (!TERMINAL.has(saved.state)) {
    const owner = await regularJson(p.owner);
    if (!owner || !alive(owner.pid)) reducer.connection('unavailable');
  }
  return reducer.report();
}

function alive(pid) {
  if (!Number.isSafeInteger(pid) || pid < 1) return false;
  try { process.kill(pid, 0); return true; } catch (error) { return error.code === 'EPERM'; }
}

async function publishExclusive(file, owner) {
  const temporary = `${file}.${randomUUID()}.tmp`;
  let handle;
  try {
    handle = await open(temporary, 'wx', 0o600);
    await handle.writeFile(JSON.stringify(owner) + '\n');
    await handle.close(); handle = null;
    // Atomic publication prevents a crash from leaving a half-written owner.
    await link(temporary, file);
    return true;
  } catch (error) {
    if (error.code === 'EEXIST') return false;
    throw error;
  } finally { await handle?.close(); await rm(temporary, { force: true }); }
}

async function reserveReclaim(p, deadOwner, depth = 0) {
  if (depth >= 32 || !UUID.test(deadOwner?.token) || alive(deadOwner.pid)) return false;
  // A permanent marker for this exact dead owner elects one reclaimer. Keeping
  // it avoids the unlink/recreate race of a second mutable lock. If the elected
  // reclaimer itself crashed, another marker for its unique token permits safe
  // recovery. Ordinary starts/stops create no markers.
  const file = join(p.directory, `.progress-reclaim-${deadOwner.token}.json`);
  if (await publishExclusive(file, { pid: process.pid, token: randomUUID() })) return true;
  const elected = await regularJson(file);
  return elected ? reserveReclaim(p, elected, depth + 1) : false;
}

async function claim(p, token) {
  const next = { pid: process.pid, token };
  if (await publishExclusive(p.owner, next)) return true;
  const owner = await regularJson(p.owner);
  if (!owner || alive(owner.pid) || !await reserveReclaim(p, owner)) return false;
  const current = await regularJson(p.owner);
  if (current?.token !== owner.token || current?.pid !== owner.pid) return false;
  await rm(p.owner, { force: true });
  return publishExclusive(p.owner, next);
}

function websocketUrl(url, id) {
  const parsed = new URL(url);
  if (!['http:', 'https:'].includes(parsed.protocol) || !['127.0.0.1', '[::1]'].includes(parsed.hostname) || parsed.username || parsed.password || parsed.pathname !== '/' || parsed.search || parsed.hash) {
    throw new Error('Progress monitoring requires the selected numeric loopback ComfyUI origin.');
  }
  parsed.protocol = parsed.protocol === 'https:' ? 'wss:' : 'ws:';
  parsed.pathname = '/ws';
  parsed.searchParams.set('clientId', id);
  return parsed.toString();
}

class ProgressMonitor {
  constructor(job, options, p, token, previous) {
    this.job = job;
    this.options = options;
    this.paths = p;
    this.token = token;
    this.reducer = new GenerationProgress(job, { promptId: options.promptId ?? job.id, previous, now: options.now });
    this.writeChain = Promise.resolve();
    this.reconnectCount = 0;
    this.started = Date.now();
    this.closed = false;
    this.deadline = setTimeout(() => { void this.close('unavailable'); }, options.maxLifetimeMs ?? 24 * 60 * 60 * 1000);
    this.deadline.unref?.();
  }

  async persist() {
    const snapshot = this.reducer.report();
    this.writeChain = this.writeChain.catch(() => {}).then(async () => {
      const owner = await regularJson(this.paths.owner);
      if (owner?.token !== this.token) return;
      const temp = join(this.paths.directory, `.progress-${this.token}-${randomUUID()}.tmp`);
      let handle;
      try {
        handle = await open(temp, 'wx', 0o600);
        await handle.writeFile(JSON.stringify(snapshot) + '\n');
        await handle.close(); handle = null;
        await rename(temp, this.paths.snapshot);
      } finally { await handle?.close(); await rm(temp, { force: true }); }
    });
    return this.writeChain;
  }

  async connect() {
    if (this.closed) return;
    const WebSocketImpl = this.options.WebSocketImpl ?? globalThis.WebSocket;
    if (!WebSocketImpl) return this.close('unavailable');
    this.reducer.connection(this.reconnectCount ? 'reconnecting' : 'connecting');
    const socket = new WebSocketImpl(websocketUrl(this.options.url ?? this.job.comfyUrl, this.job.id));
    this.socket = socket;
    const connectionTimeout = setTimeout(() => { try { socket.close(); } catch {} }, this.options.socketTimeoutMs ?? 10_000);
    connectionTimeout.unref?.();
    const ready = new Promise(resolveReady => {
      let done = false;
      const finishReady = () => { if (!done) { done = true; resolveReady(); } };
      socket.addEventListener('open', () => {
        clearTimeout(connectionTimeout);
        if (this.closed) { socket.close(); return finishReady(); }
        this.reducer.connection('live');
        this.lastConnected = Date.now();
        this.disconnectedAt = undefined;
        this.reconnectCount = 0;
        void this.persist().catch(() => {});
        finishReady();
      });
      socket.addEventListener('message', event => {
        if (this.closed || this.socket !== socket || typeof event.data !== 'string' || event.data.length > MAX_MESSAGE) return;
        let eventData;
        try { eventData = JSON.parse(event.data); } catch { return; }
        if (this.reducer.receive(eventData.type, eventData.data)) {
          void this.persist().catch(() => {});
          if (TERMINAL.has(this.reducer.snapshot.state)) void this.close('closed');
        }
      });
      const lost = () => {
        clearTimeout(connectionTimeout);
        finishReady();
        if (this.closed || this.socket !== socket) return;
        this.socket = null;
        try { socket.close(); } catch {}
        this.reducer.connection('reconnecting');
        void this.persist().catch(() => {});
        this.reconnectCount++;
        this.disconnectedAt ??= Date.now();
        if (Date.now() - this.disconnectedAt > (this.options.maxDisconnectedMs ?? 5 * 60 * 1000) || this.reconnectCount > 12) {
          void this.close('unavailable');
          return;
        }
        this.reconnectTimer = setTimeout(() => { void this.connect().catch(() => this.close('unavailable')); }, Math.min(30_000, (this.options.reconnectDelayMs ?? 1000) * 2 ** Math.min(5, this.reconnectCount - 1)));
        this.reconnectTimer.unref?.();
      };
      socket.addEventListener('close', lost);
      socket.addEventListener('error', lost);
    });
    const boundedWait = new Promise(resolveWait => {
      const timeout = setTimeout(resolveWait, this.options.connectTimeoutMs ?? 250);
      ready.finally(() => clearTimeout(timeout));
    });
    await Promise.race([ready, boundedWait]);
  }

  async close(connection = 'closed', outcome) {
    if (this.closing) return this.closing;
    this.closed = true;
    clearTimeout(this.deadline);
    clearTimeout(this.reconnectTimer);
    if (outcome) this.reducer.finish(outcome.status, outcome.reason);
    this.reducer.connection(connection);
    try { this.socket?.close(); } catch {}
    this.closing = (async () => {
      await this.persist().catch(() => {});
      const owner = await regularJson(this.paths.owner);
      if (owner?.token === this.token) await rm(this.paths.owner, { force: true });
      if (monitors.get(this.paths.directory) === this) monitors.delete(this.paths.directory);
    })();
    return this.closing;
  }
}

/** Best-effort side channel: unavailable observation must never block generation. */
export async function ensureJobProgress(job, options) {
  const p = paths(options.dataDir, job.id);
  const existing = monitors.get(p.directory);
  if (existing) {
    if (options.promptId) existing.reducer.setPromptId(options.promptId);
    return existing.reducer.report();
  }
  if (inFlight.has(p.directory)) return inFlight.get(p.directory);
  const operation = (async () => {
    await safeDirectory(p);
    const storedJob = await regularJson(join(p.directory, 'job.json'));
    if (storedJob?.id !== job.id || storedJob?.runtimeId !== job.runtimeId || storedJob?.comfyUrl !== job.comfyUrl) return null;
    const previous = await regularJson(p.snapshot);
    if (TERMINAL.has(previous?.state)) return readJobProgress(options.dataDir, job);
    if (monitors.size >= MAX_MONITORS) return readJobProgress(options.dataDir, job);
    const token = randomUUID();
    if (!await claim(p, token)) return readJobProgress(options.dataDir, job);
    const monitor = new ProgressMonitor(job, options, p, token, previous);
    monitors.set(p.directory, monitor);
    try {
      await monitor.persist();
      await monitor.connect();
      return monitor.reducer.report();
    } catch {
      await monitor.close('unavailable');
      return readJobProgress(options.dataDir, job);
    }
  })().catch(() => null);
  inFlight.set(p.directory, operation);
  try { return await operation; } finally { inFlight.delete(p.directory); }
}

export async function stopJobProgress(dataDir, job, outcome) {
  const p = paths(dataDir, job.id);
  const monitor = monitors.get(p.directory);
  if (monitor) await monitor.close('closed', outcome);
  const snapshot = await readJobProgress(dataDir, job);
  if (outcome && TERMINAL.has(outcome.status)) {
    const reducer = new GenerationProgress(job, { promptId: snapshot?.promptId ?? job.id, previous: snapshot });
    reducer.finish(outcome.status, outcome.reason);
    reducer.connection('closed');
    return reducer.report();
  }
  return snapshot;
}

/** Scope by dataDir and/or runtimeId when switching cloud runtimes. */
export async function closeProgressMonitors({ dataDir, runtimeId } = {}) {
  // A concurrent ensure may still be acquiring its lock; let its bounded
  // connect finish before taking the monitor snapshot used for shutdown.
  await Promise.allSettled([...inFlight.values()]);
  const selected = [...monitors.values()].filter(monitor =>
    (dataDir === undefined || monitor.paths.root === resolve(dataDir)) &&
    (runtimeId === undefined || monitor.job.runtimeId === runtimeId));
  await Promise.allSettled(selected.map(monitor => monitor.close('closed')));
}
