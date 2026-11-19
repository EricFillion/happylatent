import { constants } from 'node:fs';
import { lstat, open, realpath, rm } from 'node:fs/promises';
import { homedir } from 'node:os';
import { join, posix, win32 } from 'node:path';
import { createCredentialStore } from './credential-store.mjs';

const WHOAMI_URL = 'https://huggingface.co/api/whoami-v2';
// These two files are retained only for explicit cleanup of older installations.
const TOKEN_FILE = 'happylatent-credential.json';
const LEGACY_TOKEN_FILE = 'happylatent-token.json';
const CREDENTIAL_ID = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;
export const HF_TOKEN_SETTINGS_URL = 'https://huggingface.co/settings/tokens';
const TOKEN_PATTERN = /^hf_[A-Za-z0-9]{10,256}$/;
const REQUIRED_AUTH = 'Run hf auth login yourself in a separate terminal and select Paste an access token. Use a general read token or a dedicated fine-grained token with only model repository read permissions. If already logged in, use hf auth login --force, then retry.';
const PERMISSION_ERROR = 'Use a general read token or a fine-grained token with only model repository read permissions. Remove write, account, inference, and other permissions. Run hf auth login --force yourself in a separate terminal and select Paste an access token.';

function plainObject(value) {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

// Permission metadata is documented by the Hub's public OpenAPI whoami-v2 schema:
// https://huggingface.co/.well-known/openapi.json
// Fail closed when the provider adds an unfamiliar permission or metadata shape.
function checkedPermissions(accessToken) {
  if (!plainObject(accessToken) || !['read', 'fineGrained'].includes(accessToken.role) ||
      Object.keys(accessToken).some(key => !['role', 'fineGrained', 'displayName', 'createdAt'].includes(key))) {
    throw new Error(PERMISSION_ERROR);
  }
  if (accessToken.role === 'read') {
    if (accessToken.fineGrained !== undefined) throw new Error(PERMISSION_ERROR);
    return { role: 'read' };
  }
  const fineGrained = accessToken.fineGrained;
  if (!plainObject(fineGrained) || !Array.isArray(fineGrained.scoped) ||
      Object.keys(fineGrained).some(key => !['scoped', 'global', 'canReadGatedRepos'].includes(key)) ||
      (fineGrained.global !== undefined && (!Array.isArray(fineGrained.global) || fineGrained.global.length !== 0)) ||
      (fineGrained.canReadGatedRepos !== undefined && typeof fineGrained.canReadGatedRepos !== 'boolean')) {
    throw new Error(PERMISSION_ERROR);
  }
  for (const grant of fineGrained.scoped) {
    if (!plainObject(grant) || Object.keys(grant).some(key => !['entity', 'permissions'].includes(key)) ||
        !plainObject(grant.entity) || grant.entity.type !== 'model' ||
        !/^[0-9a-f]{24}$/.test(grant.entity._id) ||
        Object.keys(grant.entity).some(key => !['_id', 'type', 'name'].includes(key)) ||
        (grant.entity.name !== undefined && typeof grant.entity.name !== 'string') ||
        !Array.isArray(grant.permissions) ||
        grant.permissions.some(permission => !['repo.content.read'].includes(permission))) {
      throw new Error(PERMISSION_ERROR);
    }
  }
  return { role: 'fineGrained', fineGrained };
}

// Match the official Hub cache locations without accepting ambient HF_TOKEN.
// The CLI owns writing, switching and logging out; Happy Latent only reads the
// active credential. stateDir does not select a separate Hugging Face login.
export function hfTokenPath({ env = process.env, homeDir = homedir(), platform = process.platform } = {}) {
  const paths = platform === 'win32' ? win32 : posix;
  const expandHome = value => value === '~' ? homeDir
    : value.startsWith('~/') || (platform === 'win32' && value.startsWith('~\\'))
      ? paths.join(homeDir, value.slice(2)) : value;
  const cacheHome = env.XDG_CACHE_HOME || paths.join(homeDir, '.cache');
  const hfHome = env.HF_HOME || paths.join(cacheHome, 'huggingface');
  return paths.resolve(expandHome(env.HF_TOKEN_PATH || paths.join(expandHome(hfHome), 'token')));
}

async function readCliToken(options) {
  const tokenPath = hfTokenPath(options);
  const platform = options.platform ?? process.platform;
  const paths = platform === 'win32' ? win32 : posix;
  const directory = paths.dirname(tokenPath);
  let handle;
  try {
    const parent = await lstat(directory);
    if (!parent.isDirectory() || (platform !== 'win32' && (!owned(parent) || (parent.mode & 0o022) !== 0))) return undefined;
    const canonicalParent = await realpath(directory);
    const before = await lstat(tokenPath);
    if (!before.isFile() || before.nlink !== 1 || before.size > 512 ||
        (platform !== 'win32' && (!owned(before) || (before.mode & 0o022) !== 0))) return undefined;
    handle = await open(tokenPath, constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0) | (constants.O_NONBLOCK ?? 0));
    const file = await handle.stat();
    if (!file.isFile() || file.dev !== before.dev || file.ino !== before.ino || file.nlink !== 1 || file.size > 512 ||
        (platform !== 'win32' && (!owned(file) || (file.mode & 0o022) !== 0))) return undefined;
    // Bound the actual read, not only the initial size, in case the CLI changes
    // the file concurrently. Never print file contents or low-level errors.
    const buffer = Buffer.alloc(513);
    const { bytesRead } = await handle.read(buffer, 0, buffer.length, 0);
    if (bytesRead > 512 || await realpath(directory) !== canonicalParent) return undefined;
    const after = await lstat(tokenPath);
    if (!after.isFile() || after.dev !== file.dev || after.ino !== file.ino) return undefined;
    const token = buffer.subarray(0, bytesRead).toString('utf8').trim();
    buffer.fill(0);
    return TOKEN_PATTERN.test(token) ? token : undefined;
  } catch {
    return undefined;
  } finally { await handle?.close(); }
}

async function validateToken(token, fetchImpl) {
  let response;
  let metadata;
  try {
    response = await fetchImpl(WHOAMI_URL, {
      headers: { Authorization: `Bearer ${token}` },
      redirect: 'manual',
      signal: AbortSignal.timeout(15_000),
    });
    if (response.status === 200) metadata = await response.json();
    else await response.body?.cancel();
  } catch {
    throw new Error('Could not validate the saved Hugging Face login. Check your connection and retry.');
  }
  if (response.status !== 200) throw new Error('Hugging Face could not validate the saved login. ' + REQUIRED_AUTH);
  if (metadata?.auth?.type !== 'access_token') throw new Error(PERMISSION_ERROR);
  return checkedPermissions(metadata.auth.accessToken);
}

export async function authToken(_stateDir, { required = true, fetchImpl = globalThis.fetch, ...options } = {}) {
  const token = await readCliToken(options);
  if (!token) {
    if (required) throw new Error(REQUIRED_AUTH);
    return undefined;
  }
  // Revalidate on every access. Logging in with another token, revocation or
  // changed permissions must take effect without restarting the MCP server.
  await validateToken(token, fetchImpl);
  return token;
}

// Compatibility command: check the user's official CLI login without prompting
// for, saving, printing or launching an interactive flow for the credential.
export async function runAuth({ stateDir, force = false }, {
  output = process.stderr, fetchImpl = globalThis.fetch, ...options
} = {}) {
  if (force) throw new Error('To change your saved Hugging Face login, run hf auth login --force yourself in a separate terminal and select Paste an access token.');
  const token = await readCliToken(options);
  if (!token) throw new Error(REQUIRED_AUTH);
  const accessToken = await validateToken(token, fetchImpl);
  output.write('Hugging Face CLI login verified: a read-only token is available. The CLI manages its local credential files. Model downloads still require approval.\n');
  if (accessToken.fineGrained?.canReadGatedRepos) {
    output.write('This token also permits reads of all public gated repositories your account can access.\n');
  }
  return { authenticated: true, credentialSource: 'huggingface-cli' };
}

// Legacy cleanup only; never used to authenticate or modify the HF CLI cache.
async function info(path) {
  try { return await lstat(path); } catch (error) {
    if (error.code === 'ENOENT') return undefined;
    throw error;
  }
}

function owned(info) {
  return typeof process.getuid !== 'function' || info.uid === process.getuid();
}

async function authDirectory(stateDir) {
  let root = await info(stateDir);
  if (root && (!root.isDirectory() || !owned(root) || (root.mode & 0o022) !== 0)) {
    throw new Error('The authentication state directory must be owned by this user and not writable by others.');
  }
  const directory = join(stateDir, 'huggingface');
  const directoryInfo = await info(directory);
  if (!directoryInfo) return undefined;
  if (!directoryInfo.isDirectory() || !owned(directoryInfo)) throw new Error('The authentication cache must be a private directory owned by this user.');
  if ((directoryInfo.mode & 0o077) !== 0) {
    throw new Error('The authentication cache directory must have private permissions.');
  }
  return directory;
}

async function readCredentialMetadata(directory) {
  let handle;
  try {
    handle = await open(join(directory, TOKEN_FILE), constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
    const file = await handle.stat();
    if (!file.isFile() || !owned(file) || file.nlink !== 1 || (file.mode & 0o777) !== 0o600 || file.size > 16_384) {
      throw new Error('Unsafe credential metadata.');
    }
    const cached = JSON.parse(await handle.readFile('utf8'));
    if (cached.version !== 2 || !CREDENTIAL_ID.test(cached.credentialId) ||
        !['macos-keychain', 'linux-secret-service'].includes(cached.store) ||
        Object.keys(cached).some(key => !['version', 'store', 'credentialId', 'accessToken'].includes(key))) {
      throw new Error('Invalid credential metadata.');
    }
    checkedPermissions(cached.accessToken);
    return cached;
  } finally { await handle?.close(); }
}

async function withAuthLock(directory, work) {
  const lockPath = join(directory, '.auth.lock');
  let lock;
  try {
    lock = await open(lockPath, 'wx', 0o600);
  } catch {
    throw new Error('Another authentication operation is active. Retry after it finishes.');
  }
  try { return await work(); }
  finally { await lock.close(); await rm(lockPath, { force: true }); }
}

async function safeExisting(path) {
  const existing = await info(path);
  if (existing && (!existing.isFile() || !owned(existing) || existing.nlink !== 1)) {
    throw new Error('The existing credential metadata is not a safe file.');
  }
  return existing;
}

export async function forgetAuth({ stateDir }, { credentialStore } = {}) {
  const result = { legacyForgotten: true, hfCliCredentialsUnchanged: true, revoked: false,
    logoutCommand: 'hf auth logout', revokeUrl: HF_TOKEN_SETTINGS_URL };
  const directory = await authDirectory(stateDir);
  if (!directory) return result;
  return withAuthLock(directory, async () => {
    const target = join(directory, TOKEN_FILE);
    const legacy = join(directory, LEGACY_TOKEN_FILE);
    const current = await safeExisting(target);
    const plaintext = await safeExisting(legacy);
    if (current) {
      const cached = await readCredentialMetadata(directory);
      const store = credentialStore ?? await createCredentialStore(stateDir);
      if (store.name !== cached.store) throw new Error('Forget this credential on the operating system where it was saved.');
      // Looking up the active item lets the OS unlock it first. Clear all items
      // for this installation, including a previous item left by failed cleanup.
      await store.get(cached.credentialId);
      await store.clear();
      if (await store.get(cached.credentialId) !== undefined) throw new Error('Unlock the OS credential store and retry forgetting the credential.');
      await rm(target);
    }
    if (plaintext) await rm(legacy); // Explicit forget never reads legacy tokens.
    return result;
  });
}
