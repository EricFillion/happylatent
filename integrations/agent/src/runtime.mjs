import { spawn } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { mkdir, open, readFile, realpath, rename, rm, stat, writeFile } from 'node:fs/promises';
import { get } from 'node:http';
import { createConnection } from 'node:net';
import { join, resolve } from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import { fileURLToPath } from 'node:url';

export function runtimeLayout(stateDir) {
  const runtime = join(stateDir, 'runtime');
  return { runtime, comfy: join(runtime, 'ComfyUI'), python: join(runtime, 'venv', 'bin', 'python'),
    log: join(runtime, 'comfyui.log'), endpoint: join(runtime, 'comfyui.url'),
    control: join(runtime, 'control.json'), lock: join(runtime, 'startup.lock') };
}

export function isManagedConfig(config) {
  if (config.runtime?.managed === false) return false;
  return config.runtime?.managed === true ||
    (config.comfyRoot && resolve(config.comfyRoot) === runtimeLayout(config.stateDir).comfy);
}

export async function localRuntimeJson(url, path) {
  // These short readiness/queue probes must not reuse a socket while its owned
  // backend is shutting down. Native HTTP also makes redirects impossible.
  return new Promise((resolveJson, reject) => {
    const request = get(new URL(path, url), { agent: false }, response => {
      let body = '';
      response.setEncoding('utf8');
      response.on('error', reject);
      response.on('data', chunk => {
        body += chunk;
        if (body.length > 1024 * 1024) request.destroy(new Error('Runtime response exceeds 1 MiB.'));
      });
      response.on('end', () => {
        try {
          if (response.statusCode !== 200) throw new Error(`Runtime HTTP ${response.statusCode}.`);
          resolveJson(JSON.parse(body));
        } catch (error) { reject(error); }
      });
    });
    request.setTimeout(3000, () => request.destroy(new Error('Runtime HTTP request timed out.')));
    request.on('error', reject);
  });
}

export async function isManagedComfy(comfy, url) {
  try {
    if (!(await stat(join(comfy, 'main.py'))).isFile()) return false;
    const parsed = new URL(url);
    if (parsed.protocol !== 'http:' || !['127.0.0.1', 'localhost'].includes(parsed.hostname) ||
        parsed.username || parsed.password || parsed.pathname !== '/' || parsed.search || parsed.hash) return false;
    const entry = (await localRuntimeJson(parsed.origin, '/system_stats')).system?.argv?.[0];
    return typeof entry === 'string' && resolve(entry) === entry &&
      await realpath(entry) === await realpath(join(comfy, 'main.py'));
  } catch { return false; }
}

async function controlInfo(config) {
  try {
    const info = JSON.parse(await readFile(runtimeLayout(config.stateDir).control, 'utf8'));
    if (!Number.isInteger(info.port) || info.port < 1 || info.port > 65535 ||
        typeof info.token !== 'string' || info.token.length < 32 || info.comfyUrl !== config.comfyUrl) return;
    return info;
  } catch (error) {
    if (error.code !== 'ENOENT' && !(error instanceof SyntaxError)) throw error;
  }
}

async function request(config, operation, { hold = false } = {}) {
  const info = await controlInfo(config);
  if (!info) throw new Error('Managed runtime supervisor is not running.');
  return new Promise((resolveRequest, reject) => {
    const socket = createConnection({ host: '127.0.0.1', port: info.port });
    let input = '';
    let settled = false;
    const timer = setTimeout(() => {
      socket.destroy();
      reject(new Error('Managed runtime did not respond in time. Inspect its log.'));
    }, operation === 'acquire' || operation === 'start' ? 120000 : 10000);
    timer.unref();
    const fail = error => { clearTimeout(timer); if (!settled) reject(error); };
    socket.once('error', fail);
    socket.once('close', () => fail(new Error('Managed runtime supervisor disconnected.')));
    socket.once('connect', () => socket.write(JSON.stringify({ token: info.token, operation }) + '\n'));
    socket.on('data', chunk => {
      input += chunk;
      if (input.length > 65536) { socket.destroy(); return; }
      if (!input.includes('\n') || settled) return;
      settled = true;
      clearTimeout(timer);
      try {
        const result = JSON.parse(input.split('\n')[0]);
        if (result.error) throw new Error(result.error);
        if (!hold) socket.end();
        else socket.unref();
        resolveRequest({ result, socket });
      } catch (error) { socket.destroy(); reject(error); }
    });
  });
}

async function available(config) {
  try { return (await request(config, 'status')).result; } catch { return undefined; }
}

async function staleLock(path) {
  const owner = Number(await readFile(path, 'utf8').catch(() => ''));
  if (Number.isInteger(owner) && owner > 0) {
    try { process.kill(owner, 0); } catch (error) { return error.code === 'ESRCH'; }
    return false;
  }
  return Date.now() - (await stat(path).catch(() => ({ mtimeMs: Date.now() }))).mtimeMs > 10000;
}

async function recoverLock(path) {
  // Serialize recovery too: two waiters must not remove each other's new lock.
  let recovery;
  try { recovery = await open(`${path}.recovery`, 'wx', 0o600); }
  catch (error) { if (error.code === 'EEXIST') return; throw error; }
  try { if (await staleLock(path)) await rm(path, { force: true }); }
  finally { await recovery.close(); await rm(`${path}.recovery`, { force: true }); }
}

async function withStartupLock(config, work) {
  const paths = runtimeLayout(config.stateDir);
  await mkdir(paths.runtime, { recursive: true, mode: 0o700 });
  const deadline = Date.now() + 120000;
  let handle;
  while (!handle) {
    try {
      handle = await open(paths.lock, 'wx', 0o600);
      await handle.writeFile(String(process.pid));
    } catch (error) {
      if (error.code !== 'EEXIST') throw error;
      // Recover a crashed launcher. Never signal a PID read from disk.
      if (await staleLock(paths.lock)) await recoverLock(paths.lock);
      if (Date.now() > deadline) throw new Error(`Another runtime startup is still active. Inspect ${paths.log}.`);
      await delay(100);
    }
  }
  try { return await work(); }
  finally { await handle.close(); await rm(paths.lock, { force: true }); }
}

async function launchSupervisor(config) {
  const paths = runtimeLayout(config.stateDir);
  return withStartupLock(config, async () => {
    for (let attempt = 0; ; attempt++) {
      const current = await available(config);
      if (!current) break;
      if (current.status !== 'stopping') return;
      if (attempt >= 100) throw new Error(`Managed runtime is still stopping. Inspect ${paths.log}.`);
      await delay(100);
    }
    for (const path of [paths.python, join(paths.comfy, 'main.py'), join(paths.runtime, 'python-ready')]) {
      try { await stat(path); } catch {
        throw new Error(`Managed runtime is incomplete. Rerun setup --managed. Missing ${path}.`);
      }
    }
    const output = await open(paths.log, 'a', 0o600);
    let child;
    try {
      child = spawn(process.execPath, [fileURLToPath(new URL('./runtime-worker.mjs', import.meta.url)),
        Buffer.from(JSON.stringify({ stateDir: config.stateDir, comfyUrl: config.comfyUrl })).toString('base64url')],
      { detached: true, stdio: ['ignore', output.fd, output.fd] });
      await new Promise((resolve, reject) => { child.once('spawn', resolve); child.once('error', reject); });
      child.unref();
    } finally { await output.close(); }
    for (let attempt = 0; attempt < 100; attempt++) {
      if (await available(config)) return;
      if (child.exitCode !== null || child.signalCode !== null) break;
      await delay(100);
    }
    // Only this child handle is signalled, never an old PID from the state directory.
    child.kill('SIGTERM');
    throw new Error(`Could not start the managed runtime supervisor. Inspect ${paths.log}.`);
  });
}

export class ManagedRuntime {
  constructor(config) { this.config = config; this.lease = null; this.pending = null; this.closed = false; }
  async ensure() {
    if (!isManagedConfig(this.config)) return { status: 'external', managed: false, comfyUrl: this.config.comfyUrl };
    if (this.closed) throw new Error('Managed runtime client is closed.');
    if (this.lease && !this.lease.destroyed) return { status: 'running', managed: true, comfyUrl: this.config.comfyUrl };
    if (this.pending) return this.pending;
    this.pending = (async () => {
      // Older setup versions and manually launched ComfyUI processes have no
      // supervisor owner. Reuse them, but never adopt their PID or stop them.
      if (!await available(this.config) && await isManagedComfy(runtimeLayout(this.config.stateDir).comfy, this.config.comfyUrl)) {
        return { status: 'running', managed: true, supervised: false, comfyUrl: this.config.comfyUrl };
      }
      for (let attempt = 0; ; attempt++) {
        await launchSupervisor(this.config);
        try {
          const { result, socket } = await request(this.config, 'acquire', { hold: true });
          if (this.closed) socket.end();
          else this.lease = socket;
          return result;
        } catch (error) {
          if (attempt || !(/shutting down|disconnected/.test(error.message) || ['ECONNREFUSED', 'ECONNRESET'].includes(error.code))) throw error;
          await delay(100);
        }
      }
    })();
    try { return await this.pending; } finally { this.pending = null; }
  }
  async start() {
    if (!isManagedConfig(this.config)) return { status: 'external', managed: false, comfyUrl: this.config.comfyUrl };
    if (!await available(this.config) && await isManagedComfy(runtimeLayout(this.config.stateDir).comfy, this.config.comfyUrl)) {
      return { status: 'running', managed: true, supervised: false, comfyUrl: this.config.comfyUrl };
    }
    await launchSupervisor(this.config);
    return (await request(this.config, 'start')).result;
  }
  async status() {
    if (!isManagedConfig(this.config)) return { status: 'external', managed: false, comfyUrl: this.config.comfyUrl };
    const paths = runtimeLayout(this.config.stateDir);
    const supervisor = await available(this.config);
    if (supervisor) return supervisor;
    const running = await isManagedComfy(paths.comfy, this.config.comfyUrl);
    return { status: running ? 'unmanaged_process' : 'stopped', managed: true, comfyUrl: this.config.comfyUrl,
      log: paths.log, ...(running ? { next: 'This existing process was started outside the supervisor. Stop it yourself once, then run start.' } : {}) };
  }
  async stop() {
    if (!isManagedConfig(this.config)) return { status: 'external', managed: false, comfyUrl: this.config.comfyUrl };
    const current = await this.status();
    if (current.status === 'stopped') return current;
    if (current.status === 'unmanaged_process') throw new Error(current.next);
    return (await request(this.config, 'stop')).result;
  }
  async close() {
    this.closed = true;
    if (this.pending) await this.pending.catch(() => {});
    this.lease?.end();
    this.lease = null;
  }
}

export async function writeControl(path, data) {
  const temporary = `${path}.${randomUUID()}.tmp`;
  try {
    await writeFile(temporary, JSON.stringify(data), { mode: 0o600, flag: 'wx' });
    await rename(temporary, path);
  } finally { await rm(temporary, { force: true }); }
}
