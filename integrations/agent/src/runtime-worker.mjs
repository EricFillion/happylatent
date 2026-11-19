// The supervisor alone owns the child handle. Clients never kill a recorded PID.
import { spawn } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { open, rm } from 'node:fs/promises';
import { createServer, createConnection } from 'node:net';
import { join } from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import { isManagedComfy, localRuntimeJson, runtimeLayout, writeControl } from './runtime.mjs';

const config = JSON.parse(Buffer.from(process.argv[2], 'base64url').toString());
const paths = runtimeLayout(config.stateDir);
const url = new URL(config.comfyUrl);
if (url.protocol !== 'http:' || url.hostname !== '127.0.0.1' || !url.port || url.pathname !== '/' ||
    url.username || url.password || url.search || url.hash) throw new Error('Invalid managed runtime URL.');
const token = randomUUID();
let child, starting, closing = false, ready = false, pinned = false, idleTimer;
const leases = new Set();
const sockets = new Set();

function status() {
  return { status: closing ? 'stopping' : starting && !ready ? 'starting' : child ? 'running' : 'stopped', managed: true, supervised: true,
    comfyUrl: config.comfyUrl, clients: leases.size, pinned, log: paths.log };
}

async function queueIdle() {
  try {
    const queue = await localRuntimeJson(url.origin, '/queue');
    return Array.isArray(queue.queue_running) && Array.isArray(queue.queue_pending) &&
      queue.queue_running.length === 0 && queue.queue_pending.length === 0;
  } catch { return false; }
}

function armIdleCheck() {
  clearTimeout(idleTimer);
  if (closing || pinned || leases.size || !child || starting) return;
  idleTimer = setTimeout(async () => {
    if (closing || pinned || leases.size) return;
    if (await queueIdle()) {
      if (!pinned && !leases.size) await shutdown();
    } else armIdleCheck();
  }, 1000);
}

async function listening() {
  return new Promise(resolve => {
    const socket = createConnection({ host: '127.0.0.1', port: Number(url.port) });
    const done = result => { socket.destroy(); resolve(result); };
    socket.once('connect', () => done(true)); socket.once('error', () => done(false));
    socket.setTimeout(1000, () => done(false));
  });
}

async function startChild() {
  if (closing) throw new Error('Managed runtime is shutting down. Retry shortly.');
  if (starting) return starting;
  if (child) return;
  starting = (async () => {
    if (await listening()) throw new Error(`Port ${url.port} is occupied. An existing process cannot be adopted or stopped safely. Stop it yourself or select another port during setup.`);
    const output = await open(paths.log, 'a', 0o600);
    const env = { ...process.env, HF_HUB_OFFLINE: '1', HF_HUB_DISABLE_IMPLICIT_TOKEN: '1',
      TRANSFORMERS_OFFLINE: '1', PYTORCH_ENABLE_MPS_FALLBACK: '1' };
    for (const key of ['HF_TOKEN', 'HUGGING_FACE_HUB_TOKEN', 'HF_TOKEN_PATH', 'HF_OIDC_RESOURCE', 'HF_DEBUG']) delete env[key];
    try {
      child = spawn(paths.python, [join(paths.comfy, 'main.py'), '--listen', '127.0.0.1', '--port', url.port,
        '--disable-auto-launch', '--offline', '--disable-all-custom-nodes', '--whitelist-custom-nodes', 'happylatent'],
      { cwd: paths.comfy, env, stdio: ['ignore', output.fd, output.fd] });
      await new Promise((resolve, reject) => { child.once('spawn', resolve); child.once('error', reject); });
      child.once('exit', () => { child = undefined; ready = false; if (!closing && !starting) shutdown(); });
    } finally { await output.close(); }
    for (let attempt = 0; attempt < 90; attempt++) {
      if (await isManagedComfy(paths.comfy, url.origin)) { ready = true; return; }
      if (!child || child.exitCode !== null || child.signalCode !== null) break;
      await delay(1000);
    }
    throw new Error(`ComfyUI did not become ready. Inspect ${paths.log}.`);
  })();
  try { await starting; }
  catch (error) { setTimeout(() => shutdown(), 100).unref(); throw error; }
  finally { starting = undefined; }
}

async function shutdown() {
  if (closing) return;
  closing = true;
  clearTimeout(idleTimer);
  const owned = child;
  if (owned && owned.exitCode === null && owned.signalCode === null) {
    owned.kill('SIGTERM');
    for (let attempt = 0; attempt < 50 && owned.exitCode === null && owned.signalCode === null; attempt++) await delay(100);
    if (owned.exitCode === null && owned.signalCode === null) owned.kill('SIGKILL');
  }
  await rm(paths.control, { force: true });
  server.close();
  for (const socket of sockets) socket.end();
  setTimeout(() => process.exit(0), 50).unref();
}

const server = createServer(socket => {
  sockets.add(socket);
  socket.on('error', () => {});
  socket.on('close', () => {
    sockets.delete(socket);
    if (leases.delete(socket)) armIdleCheck();
  });
  let input = '', handled = false;
  socket.setTimeout(10000, () => { if (!handled) socket.destroy(); });
  socket.on('data', async chunk => {
    if (handled) return;
    input += chunk;
    if (input.length > 8192) { socket.destroy(); return; }
    if (!input.includes('\n')) return;
    handled = true;
    socket.setTimeout(0);
    try {
      const request = JSON.parse(input.split('\n')[0]);
      if (request.token !== token) throw new Error('Invalid runtime control token.');
      if (closing && request.operation !== 'status') throw new Error('Managed runtime is shutting down. Retry shortly.');
      if (request.operation === 'status') {
        socket.end(JSON.stringify(status()) + '\n');
      } else if (request.operation === 'acquire' || request.operation === 'start') {
        if (request.operation === 'acquire') leases.add(socket);
        else pinned = true;
        await startChild();
        if (socket.destroyed) { leases.delete(socket); armIdleCheck(); return; }
        socket.write(JSON.stringify(status()) + '\n');
        if (request.operation === 'start') socket.end();
      } else if (request.operation === 'stop') {
        if (leases.size) throw new Error('Managed runtime is in use by connected clients. Close those chats before stopping it.');
        if (starting || child && !await queueIdle()) throw new Error('Managed runtime has active work or its queue could not be checked. Wait for jobs to finish.');
        // Prevent a new lease racing the idle check and shutdown.
        if (leases.size) throw new Error('Managed runtime is in use by connected clients.');
        socket.write(JSON.stringify({ ...status(), status: 'stopped' }) + '\n');
        await shutdown();
      } else throw new Error('Unknown runtime operation.');
    } catch (error) { socket.end(JSON.stringify({ error: error.message }) + '\n'); }
  });
});

await new Promise((resolve, reject) => {
  server.once('error', reject);
  server.listen(0, '127.0.0.1', resolve);
});
await writeControl(paths.control, { port: server.address().port, token, comfyUrl: config.comfyUrl });
// A launcher may die before acquiring its first lease. Avoid an orphaned supervisor.
setTimeout(() => { if (!child && !starting && !leases.size) shutdown(); }, 15000).unref();
process.once('SIGTERM', () => shutdown());
process.once('SIGINT', () => shutdown());
