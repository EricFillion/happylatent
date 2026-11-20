/** Private, host-key-pinned OpenSSH transport for the cloud worker. */
import { spawn } from 'node:child_process';
import { lstat, mkdtemp, chmod, readFile, writeFile, rm } from 'node:fs/promises';
import { rmSync } from 'node:fs';
import net from 'node:net';
import os from 'node:os';
import path from 'node:path';

const SSH = '/usr/bin/ssh';
const activeConnections = new Set();
const onExit = () => { for (const connection of activeConnections) connection.abort(); };
const onSignal = (signal) => {
  onExit();
  if (process.listenerCount(signal) === 1) process.exit(signal === 'SIGINT' ? 130 : 143);
};
const onInterrupt = () => onSignal('SIGINT');
const onTerminate = () => onSignal('SIGTERM');

function register(connection) {
  if (activeConnections.size === 0) {
    process.on('exit', onExit);
    process.on('SIGINT', onInterrupt);
    process.on('SIGTERM', onTerminate);
  }
  activeConnections.add(connection);
}

function unregister(connection) {
  activeConnections.delete(connection);
  if (activeConnections.size === 0) {
    process.off('exit', onExit);
    process.off('SIGINT', onInterrupt);
    process.off('SIGTERM', onTerminate);
  }
}

function isPublicIpv4(host) {
  const [a, b, c] = host.split('.').map(Number);
  return !(a === 0 || a === 10 || a === 127 || a >= 224
    || (a === 100 && b >= 64 && b <= 127)
    || (a === 169 && b === 254) || (a === 172 && b >= 16 && b <= 31)
    || (a === 192 && (b === 168 || (b === 0 && (c === 0 || c === 2))))
    || (a === 198 && (b === 18 || b === 19 || (b === 51 && c === 100)))
    || (a === 203 && b === 0 && c === 113));
}

export function validateHost(host) {
  if (typeof host !== 'string' || host.length > 253 || host !== host.trim()) {
    throw new Error('Provide a public SSH IPv4 address or DNS hostname.');
  }
  const value = host.toLowerCase();
  if (value === 'ssh.runpod.io' || value.endsWith('.ssh.runpod.io')) {
    throw new Error('Use the pod direct SSH address, not the Runpod SSH proxy.');
  }
  if (net.isIP(value) === 4) {
    if (!isPublicIpv4(value)) throw new Error('SSH requires a public IPv4 address.');
    return value;
  }
  const labels = value.split('.');
  if (labels.length < 2 || /^\d[\d.]*$/.test(value)
    || !labels.every(label => /^[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?$/.test(label))
    || ['localhost', 'local', 'internal'].some(suffix => value.endsWith(`.${suffix}`))) {
    throw new Error('Provide a public SSH IPv4 address or DNS hostname.');
  }
  return value;
}

export function normalizeHostKey(hostKey) {
  if (typeof hostKey !== 'string' || hostKey.length > 16384 || /[\x00-\x1f\x7f]/.test(hostKey)) {
    throw new Error('Provide a pinned OpenSSH public host key from a trusted source.');
  }
  const [algorithm, encoded] = hostKey.trim().split(/ +/);
  if (!/^(ssh-ed25519|ssh-rsa|ecdsa-sha2-nistp(?:256|384|521))$/.test(algorithm ?? '')
    || !/^[A-Za-z0-9+/]+={0,2}$/.test(encoded ?? '')) {
    throw new Error('Unsupported or malformed SSH public host key.');
  }
  const bytes = Buffer.from(encoded, 'base64');
  if (bytes.length < 8 || bytes.readUInt32BE(0) !== algorithm.length
    || bytes.subarray(4, 4 + algorithm.length).toString('ascii') !== algorithm
    || bytes.toString('base64').replace(/=+$/, '') !== encoded.replace(/=+$/, '')
    || bytes.length <= 4 + algorithm.length + 4) {
    throw new Error('Malformed SSH public host key.');
  }
  return `${algorithm} ${encoded}`;
}

export async function validateIdentityFile(identityFile) {
  if (typeof identityFile !== 'string' || !path.isAbsolute(identityFile)
    || /[\x00-\x1f\x7f]/.test(identityFile)) throw new Error('SSH identity must be an absolute private-key file path.');
  let identity;
  try { identity = await lstat(identityFile); }
  catch (error) {
    if (error.code === 'ENOENT') throw new Error('The selected SSH key is missing. Follow the manual SSH setup guide to create or select your key; Happy Latent does not generate keys.');
    throw error;
  }
  if (!identity.isFile() || identity.isSymbolicLink()) throw new Error('SSH identity must be a regular private-key file.');
  if ((identity.mode & 0o777) !== 0o600) throw new Error('SSH private-key file permissions must be 0600.');
}

export async function identityPublicKey(identityFile) {
  const publicKeyFile = identityFile + '.pub';
  let info;
  try { info = await lstat(publicKeyFile); }
  catch (error) {
    if (error.code === 'ENOENT') throw new Error('The matching .pub file is missing. Select the public/private pair from manual SSH setup.');
    throw error;
  }
  if (!info.isFile() || info.isSymbolicLink() || info.size > 16384) throw new Error('The SSH public key must be a small regular .pub file.');
  return { publicKeyFile, publicKey: normalizeHostKey((await readFile(publicKeyFile, 'utf8')).trim()) };
}

export async function localAgentSocket(env = process.env) {
  const socket = env.SSH_AUTH_SOCK;
  // OpenSSH expands percent/dollar tokens in IdentityAgent; accept only the
  // literal socket paths used by the standard system agent.
  if (typeof socket !== 'string' || !path.isAbsolute(socket) || !/^[A-Za-z0-9_./-]+$/.test(socket)) {
    throw new Error('The local SSH agent is unavailable to Happy Latent. Unlock your key with ssh-add in your own terminal, then restart your client with access to SSH_AUTH_SOCK.');
  }
  let info;
  try { info = await lstat(socket); } catch { /* Report an actionable error without dumping environment values. */ }
  if (!info?.isSocket() || (process.getuid && info.uid !== process.getuid())) {
    throw new Error('The local SSH agent socket is missing or not owned by this user. Restart the client after unlocking your key.');
  }
  return socket;
}

export async function validateSshOptions(options) {
  if (!options || typeof options !== 'object') throw new Error('SSH connection settings are required.');
  const host = validateHost(options.host);
  const port = options.port ?? 22;
  const user = options.user ?? 'root';
  if (!Number.isInteger(port) || port < 1 || port > 65535) throw new Error('SSH port must be an integer from 1 to 65535.');
  if (typeof user !== 'string' || !/^[a-z_][a-z0-9_-]{0,31}$/i.test(user)) throw new Error('Invalid SSH username.');
  await validateIdentityFile(options.identityFile);
  const authentication = options.authentication ?? 'file';
  if (!['file', 'agent'].includes(authentication)) throw new Error('SSH authentication must be agent or file.');
  const result = { host, port, user, identityFile: options.identityFile, hostKey: normalizeHostKey(options.hostKey) };
  if (authentication === 'agent') {
    const identity = await identityPublicKey(options.identityFile);
    if (!options.publicKey || identity.publicKey !== normalizeHostKey(options.publicKey)) throw new Error('The selected public key does not match this cloud plan. Check the original SSH key before reconnecting.');
    Object.assign(result, identity, { authentication, agentSocket: await localAgentSocket() });
  }
  return result;
}

async function reserveEphemeralPort() {
  return new Promise((resolve, reject) => {
    const server = net.createServer();
    server.once('error', reject);
    server.listen({ host: '127.0.0.1', port: 0, exclusive: true }, () => {
      const port = server.address().port;
      server.close(error => error ? reject(error) : resolve(port));
    });
  });
}

function boundedTimeout(value, fallback) {
  const timeout = value ?? fallback;
  if (!Number.isInteger(timeout) || timeout < 100 || timeout > 300000) {
    throw new Error('SSH timeout must be an integer from 100 to 300000 milliseconds.');
  }
  return timeout;
}

export class SshConnection {
  #options;
  #spawn;
  #reservePort;
  #directory;
  #settings;
  #base;
  #master;
  #masterEnded = false;
  #children = new Set();
  #startup;
  #tunnel;
  #connecting;
  #closed = false;
  #closing;

  constructor(options, { spawnImpl = spawn, reservePort = reserveEphemeralPort } = {}) {
    this.#options = options;
    this.#spawn = spawnImpl;
    this.#reservePort = reservePort;
  }

  #start(args, { input, timeoutMs = 0, maxBytes = 1024 * 1024 } = {}) {
    if (this.#closed) throw new Error('SSH connection is closed.');
    const env = { ...process.env, SSH_ASKPASS_REQUIRE: 'never' };
    delete env.SSH_AUTH_SOCK;
    delete env.SSH_ASKPASS;
    const child = this.#spawn(SSH, args, { shell: false, stdio: ['pipe', 'pipe', 'pipe'], env });
    this.#children.add(child);
    let settled = false;
    let timer;
    let stdout = '';
    let stderr = '';
    let size = 0;
    const result = new Promise((resolve, reject) => {
      const finish = (error, code, signal) => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        this.#children.delete(child);
        error ? reject(error) : resolve({ stdout, stderr, exitCode: code ?? -1, signal });
      };
      const capture = name => data => {
        size += data.length;
        if (size > maxBytes) {
          child.kill('SIGKILL');
          finish(new Error('SSH output exceeded the allowed size.'));
        } else if (name === 'stdout') stdout += data.toString();
        else stderr += data.toString();
      };
      child.stdout?.on('data', capture('stdout'));
      child.stderr?.on('data', capture('stderr'));
      child.once('error', () => finish(new Error('Could not start system OpenSSH.')));
      child.once('close', (code, signal) => finish(null, code, signal));
      child.stdin?.on('error', () => {}); // EPIPE is reported by process exit.
      if (timeoutMs) timer = setTimeout(() => {
        child.kill('SIGKILL');
        finish(new Error('SSH operation timed out.'));
      }, timeoutMs);
      child.stdin?.end(input);
    });
    return { child, result };
  }

  #args(extra = [], command) {
    return [...this.#base, ...extra, '--', this.#settings.host, ...(command ? [command] : [])];
  }

  async #ensureMaster(timeoutMs) {
    if (this.#closed) throw new Error('SSH connection is closed.');
    if (this.#startup) return this.#startup;
    this.#startup = this.#createMaster(timeoutMs).catch(async error => {
      await this.close();
      throw error;
    });
    return this.#startup;
  }

  async #createMaster(timeoutMs) {
    this.#settings = await validateSshOptions(this.#options);
    if (this.#closed) throw new Error('SSH connection is closed.');
    this.#directory = await mkdtemp(path.join(os.tmpdir(), 'hlssh-'));
    if (this.#closed) {
      await rm(this.#directory, { recursive: true, force: true });
      throw new Error('SSH connection is closed.');
    }
    await chmod(this.#directory, 0o700);
    const knownHosts = path.join(this.#directory, 'known_hosts');
    const socket = path.join(this.#directory, 's');
    await writeFile(knownHosts, `happylatent-worker ${this.#settings.hostKey}\n`, { mode: 0o600 });
    if (this.#closed) {
      await rm(this.#directory, { recursive: true, force: true });
      throw new Error('SSH connection is closed.');
    }
    // Only the explicitly selected key may use the local agent. In agent mode
    // OpenSSH receives the PUBLIC file and asks the local agent to sign; it
    // never needs to read or unlock the private key. Never forward that agent.
    // Legacy file authentication remains isolated from the local agent.
    this.#base = ['-F', '/dev/null', '-S', socket, '-i', this.#settings.publicKeyFile ?? this.#settings.identityFile,
      '-l', this.#settings.user, '-p', String(this.#settings.port),
      '-o', 'BatchMode=yes', '-o', 'IdentitiesOnly=yes',
      '-o', `IdentityAgent=${this.#settings.agentSocket ?? 'none'}`,
      '-o', 'StrictHostKeyChecking=yes', '-o', `UserKnownHostsFile=${knownHosts}`,
      '-o', 'GlobalKnownHostsFile=/dev/null', '-o', 'HostKeyAlias=happylatent-worker',
      '-o', 'UpdateHostKeys=no', '-o', 'CheckHostIP=no', '-o', 'CanonicalizeHostname=no',
      '-o', 'ForwardAgent=no', '-o', 'ForwardX11=no', '-o', 'PermitLocalCommand=no',
      '-o', 'ProxyCommand=none', '-o', 'ProxyJump=none',
      '-o', 'PasswordAuthentication=no', '-o', 'KbdInteractiveAuthentication=no',
      '-o', 'NumberOfPasswordPrompts=0', '-o', 'ControlPersist=no',
      '-o', 'ExitOnForwardFailure=yes', '-o', 'ServerAliveInterval=15', '-o', 'ServerAliveCountMax=3',
      '-o', 'ConnectionAttempts=1', '-o', `ConnectTimeout=${Math.max(1, Math.ceil(timeoutMs / 1000))}`];
    register(this);
    this.#master = this.#start(this.#args(['-M', '-N', '-T']), { maxBytes: 32768 });
    this.#master.result.then(() => { this.#masterEnded = true; void this.close(); },
      () => { this.#masterEnded = true; void this.close(); });
    const deadline = Date.now() + timeoutMs;
    while (Date.now() < deadline) {
      if (this.#masterEnded || this.#closed) throw new Error('SSH authentication or pinned host-key verification failed. Check the selected key with cloud_ssh_check and verify the Pod endpoint and host key through Runpod.');
      const check = await this.#start(this.#args(['-O', 'check']), {
        timeoutMs: Math.max(1, Math.min(1000, deadline - Date.now())), maxBytes: 32768,
      }).result;
      if (check.exitCode === 0 && !this.#masterEnded && !this.#closed) return;
      await new Promise(resolve => setTimeout(resolve, Math.min(75, Math.max(0, deadline - Date.now()))));
    }
    throw new Error('SSH connection startup timed out.');
  }

  async connectTunnel({ timeoutMs } = {}) {
    timeoutMs = boundedTimeout(timeoutMs, 15000);
    if (this.#closed) throw new Error('SSH connection is closed.');
    if (this.#tunnel) return this.#tunnel;
    if (this.#connecting) return this.#connecting;
    this.#connecting = (async () => {
      await this.#ensureMaster(timeoutMs);
      const port = await this.#reservePort();
      if (!Number.isInteger(port) || port < 1 || port > 65535) throw new Error('Could not reserve a local tunnel port.');
      // Success comes from our private control master owning this forward,
      // never from probing a possibly unrelated process on the local port.
      const forward = await this.#start(this.#args(['-O', 'forward', '-L', `127.0.0.1:${port}:127.0.0.1:8188`]),
        { timeoutMs, maxBytes: 32768 }).result;
      if (forward.exitCode !== 0 || this.#masterEnded || this.#closed) {
        throw new Error('SSH could not bind its private local tunnel.');
      }
      this.#tunnel = { url: `http://127.0.0.1:${port}`, close: () => this.close() };
      return this.#tunnel;
    })().catch(async error => { await this.close(); throw error; });
    return this.#connecting;
  }

  /** Internal setup/diagnostic scripts only; this is not an MCP shell tool. */
  async run(command, { input = '', timeoutMs } = {}) {
    if (command !== 'python3 -') throw new Error('Only the fixed remote Python script runner is supported.');
    if (typeof input !== 'string' && !Buffer.isBuffer(input)) throw new Error('SSH script input must be text or bytes.');
    timeoutMs = boundedTimeout(timeoutMs, 30000);
    await this.#ensureMaster(Math.min(timeoutMs, 15000));
    if (this.#masterEnded || this.#closed) throw new Error('SSH connection is closed.');
    try {
      return await this.#start(this.#args(['-T', '-o', 'ControlMaster=no'], command), { input, timeoutMs }).result;
    } catch (error) {
      await this.close();
      throw error;
    }
  }

  /** Synchronous owned-child cleanup for process exit and signal handlers. */
  abort() {
    this.#closed = true;
    for (const child of this.#children) { try { child.kill('SIGKILL'); } catch {} }
    if (this.#directory) { try { rmSync(this.#directory, { recursive: true, force: true }); } catch {} }
  }

  async close() {
    if (this.#closing) return this.#closing;
    this.#closed = true;
    this.#closing = (async () => {
      const children = [...this.#children];
      for (const child of children) { try { child.kill('SIGKILL'); } catch {} }
      // Kill is immediate and this bounded wait allows OpenSSH to release the
      // listening socket before callers create a replacement connection.
      await Promise.all(children.map(child => new Promise(resolve => {
        if (child.exitCode != null || child.signalCode != null) return resolve();
        const timer = setTimeout(resolve, 1000);
        child.once('close', () => { clearTimeout(timer); resolve(); });
      })));
      if (this.#directory) await rm(this.#directory, { recursive: true, force: true });
      unregister(this);
    })();
    return this.#closing;
  }
}
