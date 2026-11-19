import { spawn } from 'node:child_process';
import { createHash } from 'node:crypto';
import { realpath } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';

const SERVICE = 'org.happylatent.huggingface';
const ID = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;
const TOKEN = /^hf_[A-Za-z0-9]{10,256}$/;
const HELP = 'Unlock your OS credential store and retry. macOS requires Keychain and /usr/bin/python3; Linux requires an unlocked Secret Service and /usr/bin/secret-tool (libsecret-tools). Happy Latent will not fall back to a plaintext token file.';

function unavailable() {
  return new Error(`The OS credential store is unavailable. ${HELP}`);
}

// Deliberately exclude ambient credentials and executable/library overrides.
function helperEnvironment(platform) {
  const env = { PATH: '/usr/bin:/bin', LANG: 'C.UTF-8' };
  if (platform === 'linux') {
    for (const name of ['DBUS_SESSION_BUS_ADDRESS', 'XDG_RUNTIME_DIR', 'HOME']) {
      if (process.env[name]) env[name] = process.env[name];
    }
  }
  return env;
}

function runHelper(command, args, input, { platform, spawnImpl, timeoutMs }) {
  return new Promise((resolve, reject) => {
    let child;
    let stdout = '';
    let stderr = '';
    let bytes = 0;
    let done = false;
    let timer;
    function finish(error, result) {
      if (done) return;
      done = true;
      clearTimeout(timer);
      stdout = '';
      stderr = '';
      error ? reject(unavailable()) : resolve(result);
    }
    try {
      child = spawnImpl(command, args, {
        shell: false, stdio: ['pipe', 'pipe', 'pipe'], env: helperEnvironment(platform),
      });
      timer = setTimeout(() => { child.kill('SIGKILL'); finish(true); }, timeoutMs);
      const collect = channel => chunk => {
        bytes += chunk.length;
        if (bytes > 16_384) { child.kill('SIGKILL'); finish(true); return; }
        if (channel === 'stdout') stdout += chunk.toString('utf8');
        else stderr += chunk.toString('utf8');
      };
      child.stdout.on('data', collect('stdout'));
      child.stderr.on('data', collect('stderr'));
      child.once('error', () => finish(true));
      child.stdin.once('error', () => { child.kill('SIGKILL'); finish(true); });
      child.once('close', (code, signal) => finish(Boolean(signal), { code, stdout, stderr }));
      child.stdin.end(input);
      input = '';
    } catch {
      child?.kill('SIGKILL');
      finish(true);
    }
  });
}

// Dependency injection is for tests; application calls use only OS facilities.
// Keychain/Secret Service protect credentials at rest. They do not isolate an
// agent with the same OS identity or a compromised/root process.
export async function createCredentialStore(stateDir, {
  platform = process.platform, spawnImpl = spawn, timeoutMs = 60_000,
} = {}) {
  if (!['darwin', 'linux'].includes(platform)) throw unavailable();
  const installation = createHash('sha256').update(await realpath(stateDir)).digest('hex');
  const service = `${SERVICE}.${installation}`;
  const name = platform === 'darwin' ? 'macos-keychain' : 'linux-secret-service';
  const options = { platform, spawnImpl, timeoutMs };

  async function perform(action, credentialId, token) {
    if (action !== 'clear' && !ID.test(credentialId)) throw unavailable();
    if (action === 'set' && !TOKEN.test(token)) throw unavailable();
    if (platform === 'darwin') {
      const result = await runHelper('/usr/bin/python3', [
        '-I', '-S', fileURLToPath(new URL('./keychain-helper.py', import.meta.url)),
      ], JSON.stringify({ action, service, credentialId, ...(action === 'set' ? { token } : {}) }), options);
      if (result.code !== 0 || result.stderr) throw unavailable();
      try {
        const value = JSON.parse(result.stdout);
        if (action === 'get' && (value.token === null || TOKEN.test(value.token))) return value.token ?? undefined;
        if (action !== 'get' && value.ok === true) return;
      } catch { /* Never expose native output or credential data. */ }
      throw unavailable();
    }
    const attributes = ['service', service, ...(action === 'clear' ? [] : ['credential', credentialId])];
    const args = action === 'set'
      ? ['store', '--label=Happy Latent Hugging Face model access', ...attributes]
      : [action === 'get' ? 'lookup' : 'clear', ...attributes];
    const result = await runHelper('/usr/bin/secret-tool', args, action === 'set' ? token : '', options);
    if (result.stderr || ![0, 1].includes(result.code)) throw unavailable();
    if (action === 'get') {
      if (result.code === 1 && result.stdout === '') return undefined;
      if (result.code === 0 && TOKEN.test(result.stdout)) return result.stdout;
    } else if (result.code === 0 || (action !== 'set' && result.code === 1 && !result.stdout)) {
      return;
    }
    throw unavailable();
  }
  return {
    name,
    get: id => perform('get', id),
    set: (id, token) => perform('set', id, token),
    remove: id => perform('remove', id),
    clear: () => perform('clear'),
  };
}
