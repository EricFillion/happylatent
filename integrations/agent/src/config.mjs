import { randomUUID } from 'node:crypto';
import { mkdir, readFile, rename, rm, writeFile } from 'node:fs/promises';
import { homedir } from 'node:os';
import { join, resolve } from 'node:path';

export async function readConfig(options = {}) {
  const stateDir = resolve(options['state-dir'] ?? process.env.HAPPYLATENT_STATE_DIR ??
    join(homedir(), '.happylatent-agent'));
  const runtimeProfile = process.env.HAPPYLATENT_RUNTIME_PROFILE;
  if (runtimeProfile && !/^[a-z0-9][a-z0-9_-]{0,63}$/.test(runtimeProfile)) {
    throw new Error('HAPPYLATENT_RUNTIME_PROFILE must use lowercase letters, digits, underscores or hyphens and start with a letter or digit.');
  }
  const defaults = {
    comfyUrl: 'http://127.0.0.1:8188',
    workspaceDir: join(stateDir, 'workspace'),
  };
  let saved = {};
  let configured = false;
  try {
    saved = JSON.parse(await readFile(join(stateDir, 'config.json'), 'utf8'));
    configured = true;
  } catch (error) {
    if (error.code !== 'ENOENT') throw error;
  }
  const url = new URL(options['comfy-url'] ?? saved.comfyUrl ?? defaults.comfyUrl);
  if (url.protocol !== 'http:' || !['127.0.0.1', 'localhost', '[::1]'].includes(url.hostname) ||
      url.pathname !== '/' || url.username || url.password || url.search || url.hash) {
    throw new Error('ComfyUI URL must be a local HTTP origin, for example http://127.0.0.1:8188.');
  }
  const changedUrl = options['comfy-url'] !== undefined && url.origin !== saved.comfyUrl;
  const comfyRoot = options['comfy-root'] ?? (changedUrl ? undefined : saved.comfyRoot);
  const changedConnection = options['comfy-root'] !== undefined || options['comfy-url'] !== undefined;
  const runtime = changedConnection ? { managed: false } : saved.runtime;
  if (runtime !== undefined && (typeof runtime !== 'object' || runtime === null || typeof runtime.managed !== 'boolean')) {
    throw new Error('Invalid saved runtime settings. Expected runtime.managed to be true or false.');
  }
  const speechModelDir = options['speech-model-dir'] ?? saved.speech?.modelDir;
  const speechPython = options['speech-python'] ?? saved.speech?.python ?? 'python3';
  const speechDevice = options['speech-device'] ?? saved.speech?.device ?? 'cpu';
  if (!['auto', 'mps', 'cuda', 'cpu'].includes(speechDevice)) {
    throw new Error('Use --speech-device auto, mps, cuda, or cpu.');
  }
  return {
    stateDir,
    ...(runtimeProfile ? { runtimeProfile } : {}),
    configured,
    ...(runtime ? { runtime: { managed: runtime.managed } } : {}),
    comfyUrl: url.origin,
    workspaceDir: resolve(options.workspace ?? saved.workspaceDir ?? defaults.workspaceDir),
    ...(comfyRoot ? { comfyRoot: resolve(comfyRoot) } : {}),
    ...(speechModelDir ? {
      speech: {
        modelDir: resolve(speechModelDir),
        python: speechPython.includes('/') ? resolve(speechPython) : speechPython,
        device: speechDevice,
      },
    } : {}),
  };
}

export async function saveConfig({ stateDir, comfyUrl, workspaceDir, comfyRoot, speech, runtime }) {
  await mkdir(stateDir, { recursive: true, mode: 0o700 });
  const temporary = join(stateDir, `config-${randomUUID()}.tmp`);
  try {
    await writeFile(temporary, JSON.stringify({ comfyUrl, workspaceDir, comfyRoot, speech, runtime }, null, 2) + '\n',
      { flag: 'wx', mode: 0o600 });
    await rename(temporary, join(stateDir, 'config.json'));
  } finally {
    await rm(temporary, { force: true });
  }
}
