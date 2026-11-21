import { spawn } from 'node:child_process';
import { createHash } from 'node:crypto';
import { constants, createReadStream, createWriteStream } from 'node:fs';
import {
  cp, link, lstat, mkdir, mkdtemp, open, readFile, readdir, realpath, rename, rm, stat, statfs, writeFile,
} from 'node:fs/promises';
import { createConnection } from 'node:net';
import { totalmem } from 'node:os';
import { basename, dirname, isAbsolute, join, resolve } from 'node:path';
import { createInterface } from 'node:readline/promises';
import { Transform } from 'node:stream';
import { pipeline } from 'node:stream/promises';
import { fileURLToPath } from 'node:url';

import { Comfy } from './comfy.mjs';
import { authToken } from './hf-auth.mjs';
import { ApprovalGate, assertApproval, downloadManifest } from './approvals.mjs';
import { canonicalDestination, safeModelDirectory, trustedModelUrl } from './download-safety.mjs';
import { runtimeDependencyLock } from './cloud-provenance.mjs';
import { cloudModels, MUSIC_DOWNLOAD_FILES, spatialUpscaler } from './cloud-models.mjs';
import { UPSCALE_MODELS } from './enhancements.mjs';
import { IMAGE_MODEL_PROFILE } from './images.mjs';
import { Speech, speechModelDirectory } from './speech.mjs';
import { SPEECH_DOWNLOAD_FILES } from './speech-models.mjs';
export { runAuth } from './hf-auth.mjs';
import { ManagedRuntime, isManagedComfy, isManagedConfig, runtimeLayout as layout } from './runtime.mjs';

export const MANAGED_COMFY_URL = 'http://127.0.0.1:8189';
const COMFY_REVISION = 'e3bee7ffcb7d6547ed0bcd15221792f3b8646b17';
const COMFY_REPO = 'https://github.com/Comfy-Org/ComfyUI.git';
const HF_REPO = 'Lightricks/LTX-2.5';
const HF_REVISION = '49b093a39c19169a8a81721dcc541e07e945232f';
const HF_ORIGIN = 'https://huggingface.co';
export const HF_MODEL_URL = `${HF_ORIGIN}/${HF_REPO}`;
const MODEL_FILES = {
  model: {
    path: 'diffusion_models/ltx-2.5-22b-distilled-transformer-comfy-int8-convrot.safetensors',
    size: 21504034224,
    sha256: 'c4279eeff115cbeaca494bd2183e7d768c38fe85a184dc6afbb7159157c44334',
  },
  clip: {
    path: 'text_encoders/gemma4-12b-with-proj-ltx-2.5-comfy-int8-convrot.safetensors',
    size: 15372969374,
    sha256: '6ce688a0aa98a5fa36a9f1e6c3f42152a498cc2b53ee8c15674c64244f91487f',
  },
  video_vae: {
    path: 'vae/ltx-2.5-video-vae-conv-bf16.safetensors',
    size: 1452269922,
    sha256: '685b06ee3d9b2039647698fc4ea33175112462fc374e2777312c907897dfce8d',
  },
  audio_vae: {
    path: 'vae/ltx-2.5-audio-vae-bf16.safetensors',
    size: 364866540,
    sha256: 'c52733d37f6a7fb7949c3dc0fb468c6cb2169e4d836983a73babb9f0d54837a5',
  },
  temporalUpscale: {
    path: `latent_upscale_models/${UPSCALE_MODELS.temporalUpscale.filename}`,
    size: 261944000,
    sha256: '2bc3300f2b3c3c1834d72164fbf13a3b9fd73e5a741e8a2c3f4035f89a75c3fe',
  },
};
export const LOCAL_MODEL_MEDIA = ['video', 'image', 'music', 'speech'];
const imageModels = cloudModels('image');
const IMAGE_DOWNLOAD_FILES = Object.fromEntries(Object.entries(IMAGE_MODEL_PROFILE).map(([key, { dir, filenames }]) =>
  [key, imageModels.find(file => file.path === `${dir}/${filenames[0]}`)]));
const NODE_FILES = [
  '__init__.py', 'happylatent', 'extension', 'web', 'workflows/mcp',
  'pyproject.toml', 'README.md', 'LICENSE',
];

function inspectComfy({ comfyUrl, stateDir, workspaceDir, media = 'video', enhancements }) {
  return new Comfy({ comfyUrl, dataDir: stateDir, assetRoot: workspaceDir }).checkSetup({ media, enhancements });
}

async function fileInfo(path) {
  try {
    return await lstat(path);
  } catch (error) {
    if (!['ENOENT', 'ENOTDIR'].includes(error.code)) throw error;
    return undefined;
  }
}

async function run(command, args, { cwd, capture = false } = {}) {
  return new Promise((resolve, reject) => {
    const child = spawn(command, args, {
      cwd,
      stdio: capture ? ['ignore', 'pipe', 'pipe'] : ['ignore', 'inherit', 'inherit'],
    });
    let stdout = '';
    let stderr = '';
    child.stdout?.setEncoding('utf8').on('data', (chunk) => { stdout += chunk; });
    child.stderr?.setEncoding('utf8').on('data', (chunk) => { stderr += chunk; });
    child.once('error', reject);
    child.once('close', (code, signal) => {
      if (code === 0) resolve(stdout.trim());
      else reject(new Error(`${command} ${args[0]} exited with ${signal ?? code}${stderr.trim() ? `\n${stderr.trim()}` : ''}`));
    });
  });
}

async function withLock(directory, name, work) {
  await mkdir(directory, { recursive: true, mode: 0o700 });
  const lock = join(directory, name);
  let handle;
  try {
    handle = await open(lock, 'wx', 0o600);
  } catch (error) {
    if (error.code !== 'EEXIST') throw error;
    throw new Error(`Another operation may be active. If it has stopped, remove ${lock} and retry.`);
  }
  let cleanup;
  function clean() {
    return cleanup ??= handle.close().then(() => rm(lock, { force: true }));
  }
  const interrupt = () => { clean().finally(() => process.exit(130)); };
  const terminate = () => { clean().finally(() => process.exit(143)); };
  process.once('SIGINT', interrupt);
  process.once('SIGTERM', terminate);
  try {
    await handle.writeFile(String(process.pid));
    return await work();
  } finally {
    process.off('SIGINT', interrupt);
    process.off('SIGTERM', terminate);
    await clean();
  }
}

async function localComfyRoot(path) {
  const root = await realpath(resolve(path));
  if (!(await fileInfo(join(root, 'main.py')))?.isFile() ||
      !(await fileInfo(join(root, 'folder_paths.py')))?.isFile()) {
    throw new Error(`${root} is not a ComfyUI source directory. Select the folder containing main.py and folder_paths.py.`);
  }
  return root;
}

async function nodeSource(preferred) {
  const candidates = preferred ? [resolve(preferred)] : [
    fileURLToPath(new URL('../../../', import.meta.url)),
    fileURLToPath(new URL('../resources/node/', import.meta.url)),
  ];
  for (const root of candidates) {
    if ((await fileInfo(join(root, 'happylatent/nodes.py')))?.isFile() &&
        (await fileInfo(join(root, 'web/app.js')))?.isFile()) return root;
  }
  throw new Error('Happy Latent node source and built editor are required. Run setup from the full Happy Latent repository.');
}

async function installNode(comfyRoot, nodeRoot) {
  const nodes = join(comfyRoot, 'custom_nodes');
  const destination = join(nodes, 'happylatent');
  if (await fileInfo(destination)) {
    if (!(await fileInfo(join(destination, 'happylatent/nodes.py')))?.isFile()) {
      throw new Error(`An unrecognized node already exists at ${destination}.`);
    }
    return { destination, installed: false };
  }
  const source = await nodeSource(nodeRoot);
  await mkdir(nodes, { recursive: true });
  for (const name of await readdir(nodes)) {
    const candidate = join(nodes, name);
    if (!name.endsWith('.disabled') && (await fileInfo(join(candidate, 'happylatent/nodes.py')))?.isFile()) {
      return { destination: candidate, installed: false };
    }
  }
  const temp = await mkdtemp(join(comfyRoot, '.happylatent-install-'));
  try {
    for (const name of NODE_FILES) {
      await cp(join(source, name), join(temp, name), {
        recursive: true,
        filter: (path) => basename(path) !== '__pycache__' && !path.endsWith('.pyc'),
      });
    }
    await rename(temp, destination);
    return { destination, installed: true };
  } finally {
    await rm(temp, { recursive: true, force: true });
  }
}

async function ensureComfy(runtime, comfy) {
  if (!(await fileInfo(comfy))) {
    const temp = await mkdtemp(join(runtime, '.comfy-source-'));
    try {
      await run('git', ['init', '--quiet', temp]);
      await run('git', ['-C', temp, 'fetch', '--depth', '1', COMFY_REPO, COMFY_REVISION]);
      await run('git', ['-C', temp, 'checkout', '--quiet', '--detach', 'FETCH_HEAD']);
      const head = await run('git', ['-C', temp, 'rev-parse', 'HEAD'], { capture: true });
      if (head !== COMFY_REVISION) throw new Error('The fetched ComfyUI commit differs from the requested revision.');
      await rename(temp, comfy);
    } finally {
      await rm(temp, { recursive: true, force: true });
    }
  }
  const head = await run('git', ['-C', comfy, 'rev-parse', 'HEAD'], { capture: true });
  if (head !== COMFY_REVISION) {
    throw new Error(`Managed ComfyUI at ${comfy} does not match the supported commit ${COMFY_REVISION}.`);
  }
}

async function ensurePython({ runtime, comfy, python }) {
  const venv = dirname(dirname(python));
  const stamp = join(runtime, 'python-ready');
  if (!(await fileInfo(join(venv, 'pyvenv.cfg')))) {
    try {
      await run('python3.12', ['-m', 'venv', venv]);
    } catch (error) {
      if (error.code !== 'ENOENT') throw error;
      try {
        await run('uv', ['python', 'install', '3.12']);
        await run('uv', ['venv', '--seed', '--python', '3.12', venv]);
      } catch (uvError) {
        if (uvError.code !== 'ENOENT') throw uvError;
        throw new Error('Managed setup requires Python 3.12 or uv. Install one, then rerun setup.');
      }
    }
  }
  const lock = await runtimeDependencyLock('macos');
  if (lock.metadata.comfyRevision !== COMFY_REVISION || createHash('sha256').update(await readFile(join(comfy, 'requirements.txt'))).digest('hex') !== lock.metadata.requirementsSha256) {
    throw new Error('ComfyUI requirements differ from the reviewed dependency lock. Update Happy Latent before installing.');
  }
  const fingerprint = createHash('sha256').update(JSON.stringify([COMFY_REVISION, lock.sha256])).digest('hex');
  if ((await fileInfo(python)) && (await fileInfo(stamp))?.isFile() &&
      (await readFile(stamp, 'utf8')).trim() === fingerprint) return;
  await run(python, ['-m', 'ensurepip', '--upgrade']);
  await run(python, ['-m', 'pip', '--isolated', 'install', '--require-hashes', '--only-binary=:all:', '--no-deps', '-r', lock.path], { cwd: comfy });
  await run(python, ['-m', 'pip', '--isolated', 'check'], { cwd: comfy });
  await run(python, [
    '-c',
    "import torch; assert torch.backends.mps.is_available(), 'PyTorch could not use Apple Metal on this Mac'",
  ], { cwd: comfy });
  await writeFile(stamp, `${fingerprint}\n`, { mode: 0o600 });
}

async function isListening(port) {
  return new Promise((resolve) => {
    const socket = createConnection({ host: '127.0.0.1', port });
    const done = (value) => { socket.destroy(); resolve(value); };
    socket.once('connect', () => done(true));
    socket.once('error', () => done(false));
    socket.setTimeout(1000, () => done(false));
  });
}

export async function runSetup(options) {
  const wantsManaged = options.managed || (!options.comfyRootExplicit && !options.comfyUrlExplicit && isManagedConfig(options));
  if (wantsManaged) {
    if (options.comfyRootExplicit) throw new Error('Choose --managed or --comfy-root.');
    if (process.platform !== 'darwin' || process.arch !== 'arm64') {
      throw new Error('Managed setup targets Apple Silicon Macs. Set up ComfyUI separately and connect a local URL on this platform.');
    }
    const managed = layout(options.stateDir);
    return withLock(managed.runtime, 'setup.lock', async () => {
      const previousUrl = (await fileInfo(managed.endpoint))?.isFile()
        ? (await readFile(managed.endpoint, 'utf8')).trim()
        : undefined;
      const savedUrl = options.comfyRoot === managed.comfy ? options.comfyUrl : undefined;
      const requested = new URL(options.comfyUrlExplicit ? options.comfyUrl : previousUrl ?? savedUrl ?? MANAGED_COMFY_URL);
      if (requested.protocol !== 'http:' || !['127.0.0.1', 'localhost'].includes(requested.hostname) ||
          !requested.port || requested.username || requested.password ||
          requested.pathname !== '/' || requested.search || requested.hash) {
        throw new Error('Managed setup requires a plain local HTTP address with a port, for example http://127.0.0.1:8189.');
      }
      const port = Number(requested.port);
      const comfyUrl = `http://127.0.0.1:${port}`;
      if (previousUrl && previousUrl !== comfyUrl && await isManagedComfy(managed.comfy, previousUrl)) {
        throw new Error(`Managed ComfyUI is already running at ${previousUrl}. Stop it before changing ports.`);
      }
      if (await isListening(port)) {
        if (!(await isManagedComfy(managed.comfy, comfyUrl))) {
          throw new Error(`Port ${port} is in use by another service. Choose another port with --comfy-url.`);
        }
      } else {
        const source = await nodeSource(options.nodeRoot);
        await ensureComfy(managed.runtime, managed.comfy);
        await ensurePython(managed);
        await installNode(managed.comfy, source);
        await writeFile(managed.endpoint, `${comfyUrl}\n`, { mode: 0o600 });
      }
      const runtime = new ManagedRuntime({ ...options, comfyUrl, comfyRoot: managed.comfy, runtime: { managed: true } });
      let result;
      try {
        await runtime.ensure();
        result = await inspectComfy({ ...options, comfyUrl });
      } finally {
        await runtime.close();
      }
      if (!['ready', 'missing_models'].includes(result.status)) {
        throw new Error(`Managed ComfyUI reports ${result.status}. Inspect ${managed.log}.`);
      }
      return {
        ...result, comfyUrl, comfyRoot: managed.comfy, managed: true, runtime: { managed: true },
        ready: result.status === 'ready', memoryBytes: totalmem(), log: managed.log,
      };
    });
  }

  const result = await inspectComfy(options);
  if (options.autoManaged && !options.configured && !options.comfyRoot && options.runtime?.managed !== false &&
      options.comfyUrl === 'http://127.0.0.1:8188' && !options.comfyRootExplicit && !options.comfyUrlExplicit &&
      result.status === 'unreachable' && process.platform === 'darwin' && process.arch === 'arm64') {
    return runSetup({ ...options, autoManaged: false, managed: true });
  }
  let comfyRoot = options.comfyRoot ? await localComfyRoot(options.comfyRoot) : undefined;
  const verifiedManaged = options.runtime?.managed !== false &&
    await isManagedComfy(layout(options.stateDir).comfy, result.comfyUrl);
  if (verifiedManaged) {
    comfyRoot = layout(options.stateDir).comfy;
  }
  if (['ready', 'missing_models'].includes(result.status)) {
    return { ...result, comfyRoot, runtime: { managed: verifiedManaged }, ready: result.status === 'ready' };
  }
  if (comfyRoot && ['missing_nodes', 'unreachable'].includes(result.status)) {
    const installation = await installNode(comfyRoot, options.nodeRoot);
    const prefix = installation.installed ? `Installed the node at ${installation.destination}. ` : '';
    throw new Error(`${prefix}Start or restart this ComfyUI installation, check the HappyLatentVideo node loads, then rerun setup.`);
  }
  throw new Error(`Local ComfyUI reports ${result.status}. Start ComfyUI with Happy Latent installed or use setup --managed on Apple Silicon.`);
}

async function modelTarget(comfyRoot, comfyUrl) {
  if (!comfyRoot) return undefined;
  const response = await fetch(`${comfyUrl}/system_stats`, {
    signal: AbortSignal.timeout(5000), redirect: 'error',
  });
  if (!response.ok) throw new Error('Could not check the running ComfyUI model directory.');
  const stats = await response.json();
  const argv = stats.system?.argv ?? [];
  function option(name) {
    const value = argv.find((arg) => arg.startsWith(`${name}=`))?.slice(name.length + 1);
    return value ?? (argv.includes(name) ? argv[argv.lastIndexOf(name) + 1] : undefined);
  }
  const models = option('--models-directory');
  const base = option('--base-directory');
  if ((models && !isAbsolute(models)) || (base && !isAbsolute(base))) {
    throw new Error('ComfyUI uses a relative model directory. Restart it with an absolute model or base directory before downloading.');
  }
  if (argv[0] && isAbsolute(argv[0]) && basename(argv[0]) === 'main.py' &&
      await realpath(dirname(argv[0])) !== await realpath(comfyRoot)) {
    throw new Error('The supplied ComfyUI directory differs from the running installation.');
  }
  return models ?? join(base ?? comfyRoot, 'models');
}

function downloadFiles(media) {
  if (media === 'image') return IMAGE_DOWNLOAD_FILES;
  if (media === 'music') return MUSIC_DOWNLOAD_FILES;
  if (media === 'speech') return SPEECH_DOWNLOAD_FILES;
  if (media !== 'video') throw new Error('Local model downloads support video, image, music, or speech.');
  return {
    ...Object.fromEntries(Object.entries(MODEL_FILES).map(([key, entry]) => [key,
      { ...entry, repo: HF_REPO, revision: HF_REVISION, filename: entry.path }])),
    spatialUpscale: spatialUpscaler,
  };
}

const publicModels = media => media === 'image' || media === 'speech';

function modelPlan(missing, root, media = 'video') {
  const catalog = downloadFiles(media);
  const files = missing.map(({ key }) => {
    const entry = catalog[key];
    if (!entry) throw new Error(`No pinned download is available for ${key}.`);
    return {
      key, ...entry,
      source: `${HF_ORIGIN}/${entry.repo}/resolve/${entry.revision}/${entry.filename}`,
      destination: root ? join(root, entry.path) : null,
    };
  });
  return {
    media,
    modelRepository: Object.values(catalog)[0].repo,
    revision: Object.values(catalog)[0].revision,
    modelDirectory: root ?? null,
    totalBytes: files.reduce((sum, entry) => sum + entry.size, 0),
    files,
  };
}

async function requireApproval(plan, input = process.stdin, output = process.stderr) {
  if (!input.isTTY || !output.isTTY) {
    throw new Error('Run models --download yourself in an interactive terminal to review and confirm the exact download.');
  }
  output.write(`\n${plan.modelRepository} @ ${plan.revision}\n`);
  for (const file of plan.files) {
    output.write(`\n${file.source}\n  ${(file.size / 1e9).toFixed(2)} GB (${file.size.toLocaleString('en-US')} bytes) → ${file.destination}\n`);
  }
  output.write(`\nTotal full size: ${(plan.totalBytes / 1e9).toFixed(2)} GB (${plan.totalBytes.toLocaleString('en-US')} bytes).\n`);
  const prompt = createInterface({ input, output });
  try {
    return (await prompt.question('Type DOWNLOAD to approve these model files: ')).trim() === 'DOWNLOAD';
  } finally {
    prompt.close();
  }
}

export async function checkModelAccess({ stateDir }, plan, { authTokenImpl = authToken } = {}) {
  if (plan.files.length === 0) return 'ready';
  const requiresToken = !publicModels(plan.media);
  const token = requiresToken ? await authTokenImpl(stateDir, { required: false }) : undefined;
  if (requiresToken && !token) return 'needs_token';

  const signal = AbortSignal.timeout(10_000);
  const catalog = downloadFiles(plan.media ?? 'video');
  const results = await Promise.all(plan.files.map(async (file) => {
    const entry = catalog[file.key];
    if (!entry) throw new Error('Could not check Hugging Face access for an unrecognized model.');
    const url = `${HF_ORIGIN}/${entry.repo}/resolve/${entry.revision}/${entry.filename}`;
    let response;
    try {
      response = await fetch(url, {
        method: 'HEAD',
        headers: token ? { Authorization: `Bearer ${token}` } : {},
        redirect: 'manual',
        signal,
      });
    } catch {
      throw new Error('Could not reach Hugging Face to check access. Check your internet connection and try again.');
    }
    if (response.status === 403 || response.headers.get('x-error-code')?.toLowerCase() === 'gatedrepo') return 'needs_access';
    if (response.status === 401) return 'needs_token';
    // The Hub sends metadata before redirecting large files to a CDN. Do not follow that redirect.
    if (response.ok || ([301, 302, 303, 307, 308].includes(response.status) &&
        response.headers.get('x-linked-size') === String(entry.size))) return 'ready_to_download';
    throw new Error(`Hugging Face could not verify model access (HTTP ${response.status}). Try again.`);
  }));
  if (results.includes('needs_token')) return 'needs_token';
  if (results.includes('needs_access')) return 'needs_access';
  return 'ready_to_download';
}

async function openModelResponse(source, token, offset, signal) {
  let url = trustedModelUrl(source);
  for (let redirects = 0; redirects < 6; redirects++) {
    const headers = {};
    if (token && url.origin === HF_ORIGIN) headers.Authorization = `Bearer ${token}`;
    if (offset) headers.Range = `bytes=${offset}-`;
    const timeout = AbortSignal.timeout(6 * 60 * 60 * 1000);
    const response = await fetch(url, { headers, redirect: 'manual', signal: signal ? AbortSignal.any([signal, timeout]) : timeout });
    if ([301, 302, 303, 307, 308].includes(response.status)) {
      const location = response.headers.get('location');
      await response.body?.cancel();
      if (!location) throw new Error('Model download redirect is missing its destination.');
      url = trustedModelUrl(new URL(location, url));
      continue;
    }
    if (!response.ok) {
      await response.body?.cancel();
      if ([401, 403].includes(response.status)) {
        throw new Error('Hugging Face denied access to the reviewed model file.');
      }
      throw new Error(`Model download failed with HTTP ${response.status}. Rerun models --download to resume.`);
    }
    return response;
  }
  throw new Error('Model download followed too many redirects.');
}

async function verifyModel(path, file) {
  const info = await fileInfo(path);
  if (!info?.isFile() || info.size !== file.size) return false;
  const hash = createHash('sha256');
  for await (const bytes of createReadStream(path)) hash.update(bytes);
  return hash.digest('hex') === file.sha256;
}

async function downloadModel(file, token, { output, onProgress, signal }) {
  const target = file.destination;
  const partial = `${target}.${file.sha256.slice(0, 12)}.partial`;
  await safeModelDirectory(dirname(target), { create: true });
  const existing = await fileInfo(target);
  if (existing) {
    if (!(await verifyModel(target, file))) {
      throw new Error(`Existing model differs from the pinned file at ${target}. Move it before retrying.`);
    }
    return;
  }
  const info = await fileInfo(partial);
  if (info && (!info.isFile() || info.nlink !== 1 || info.size > file.size)) {
    throw new Error(`Invalid partial file at ${partial}. Move it before retrying.`);
  }
  let offset = info?.size ?? 0;
  if (offset < file.size) {
    output?.write(`Downloading ${file.path}${offset ? ` from byte ${offset}` : ''}\n`);
    const response = await openModelResponse(file.source, token, offset, signal);
    if (!response.body || (response.status !== 200 && response.status !== 206) ||
        (response.status === 206 && response.headers.get('content-range') !== `bytes ${offset}-${file.size - 1}/${file.size}`)) {
      await response.body?.cancel();
      throw new Error('Server returned an unexpected model byte range.');
    }
    if (response.status === 200) offset = 0;
    let bytes = offset;
    let lastUpdate = performance.now();
    onProgress?.(bytes);
    const limit = new Transform({
      transform(chunk, _encoding, done) {
        bytes += chunk.length;
        if (bytes > file.size) return done(new Error('Model download exceeded the approved file size.'));
        if (onProgress && performance.now() - lastUpdate >= 200) {
          onProgress(bytes);
          lastUpdate = performance.now();
        }
        done(null, chunk);
      },
    });
    const flags = constants.O_WRONLY | constants.O_CREAT | constants.O_NOFOLLOW |
      (offset ? constants.O_APPEND : constants.O_TRUNC);
    await safeModelDirectory(dirname(target));
    await pipeline(response.body, limit, createWriteStream(partial, { flags, mode: 0o600 }), { signal });
    if (bytes !== file.size) throw new Error(`Download stopped early for ${file.path}. Rerun to resume.`);
  }
  onProgress?.(file.size);
  if (!(await verifyModel(partial, file))) {
    await rm(partial);
    throw new Error(`Downloaded SHA-256 differs from the pinned value for ${file.path}. Retry the download.`);
  }
  await safeModelDirectory(dirname(target));
  await link(partial, target);
  await rm(partial);
  output?.write(`Verified ${file.path}\n`);
}

export async function prepareModelDownload(options) {
  const media = options.media ?? 'video';
  const catalog = downloadFiles(media);
  if (options.enhancements && media !== 'video') throw new Error('Enhancements apply to video model downloads only.');
  if (media === 'speech') {
    const root = await canonicalDestination(speechModelDirectory(options));
    const installed = await Promise.all(Object.keys(catalog).map(async key => {
      const info = await stat(join(root, key)).catch(error => {
        if (error.code !== 'ENOENT') throw error;
      });
      return info?.isFile() && info.size > 0 ? null : { key };
    }));
    return modelPlan(installed.filter(Boolean), root, media);
  }
  const result = await inspectComfy(options);
  if (!['ready', 'missing_models'].includes(result.status)) {
    throw new Error(`Run setup first. Local ComfyUI reports ${result.status}.`);
  }
  const managed = layout(options.stateDir);
  const managedRoot = await isManagedComfy(managed.comfy, result.comfyUrl) ? managed.comfy : undefined;
  const comfyRoot = options.comfyRoot ? await localComfyRoot(options.comfyRoot) : managedRoot;
  const destination = await modelTarget(comfyRoot, result.comfyUrl);
  return modelPlan(result.missingModels ?? [], destination ? await canonicalDestination(destination) : undefined, media);
}

// Every execution path must carry a grant issued by a trusted client/UI adapter.
export async function executeModelDownload(options, plan, { output, onProgress, approval, signal } = {}) {
  assertApproval(approval, downloadManifest(plan));
  if (signal?.aborted) throw new Error('Download was cancelled.');
  const destination = plan.modelDirectory;
  if (plan.files.length === 0) return { ...plan, downloaded: false, ready: true };
  if (!destination) throw new Error('Provide --comfy-root to tell the installer where to put models for your existing ComfyUI.');
  await safeModelDirectory(destination, { create: true });
  return withLock(destination, '.happylatent-download.lock', async () => {
    const filesystem = await statfs(destination, { bigint: true });
    let remaining = 0;
    for (const file of plan.files) {
      const partial = await fileInfo(`${file.destination}.${file.sha256.slice(0, 12)}.partial`);
      if (!(await fileInfo(file.destination))) remaining += file.size - Math.min(partial?.size ?? 0, file.size);
    }
    if (filesystem.bavail * filesystem.bsize < BigInt(remaining)) {
      throw new Error(`The model download needs ${remaining.toLocaleString('en-US')} free bytes at ${destination}.`);
    }
    let completedBytes = 0;
    for (const file of plan.files) {
      const reportProgress = onProgress && ((bytes) => onProgress({
        file: file.path, bytes: completedBytes + bytes, totalBytes: plan.totalBytes,
      }));
      reportProgress?.(0);
      const token = publicModels(plan.media) ? undefined : await authToken(options.stateDir);
      assertApproval(approval, downloadManifest(plan));
      await downloadModel(file, token, { output, onProgress: reportProgress, signal });
      completedBytes += file.size;
      onProgress?.({ file: file.path, bytes: completedBytes, totalBytes: plan.totalBytes });
    }
    const refreshed = plan.media === 'speech' ? await new Speech(options).checkSetup()
      : await inspectComfy({ ...options, media: plan.media ?? 'video' });
    return { ...plan, downloaded: true, ready: refreshed.status === 'ready',
      ...(plan.media === 'speech' ? { setup: refreshed } : {}) };
  });
}

export async function runModels(options) {
  const plan = await prepareModelDownload(options);
  if (!options.download || plan.files.length === 0) return plan;
  if (!plan.modelDirectory) throw new Error('Provide --comfy-root to tell the installer where to put models for your existing ComfyUI.');
  const gate = new ApprovalGate(async () => ({ action: await requireApproval(plan) ? 'accept' : 'decline' }));
  let approval;
  try { approval = await gate.require(downloadManifest(plan)); }
  catch (error) { if (/Approval was not granted/.test(error.message)) return { ...plan, downloaded: false }; throw error; }
  try { return await executeModelDownload(options, plan, { output: process.stderr, approval }); }
  finally { gate.close(); }
}
