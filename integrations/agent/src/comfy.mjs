import { assetPreview } from './asset-preview.mjs';
import { createHash, randomUUID } from 'node:crypto';
import { constants, createWriteStream } from 'node:fs';
import { link, mkdir, mkdtemp, open, readFile, realpath, rename, rm } from 'node:fs/promises';
import { basename, dirname, isAbsolute, join, relative, resolve, sep } from 'node:path';
import { Readable } from 'node:stream';
import { pipeline } from 'node:stream/promises';
import { IMAGE_MODEL_PROFILE, IMAGE_NODE_INPUTS, imageOutputs, imageRequest, imageWorkflow, verifyPng } from './images.mjs';
import { ensureJobProgress, readJobProgress, stopJobProgress, explainGenerationFailure } from './progress.mjs';
import { applyEnhancementInputs, applyEnhancementUi, enhancementSetup, expectedVideo, hasEnhancements, normalizeEnhancements, UPSCALE_MODELS } from './enhancements.mjs';
import { sceneAudioCoverage, sceneUsesAudioGuidance } from '../resources/project-core/audio.js';
import { assemblyWorkflow, clipManifest, renderPlan, renderUi, videoTake } from './clips.mjs';
import { MUSIC_MODEL_PROFILE, MUSIC_NODE_INPUTS, musicRequest, musicWorkflow, musicOutputs, musicResult, verifyMusicAudio } from './music.mjs';
import { validateAsset } from '../resources/project-core/domain.js';
import { Memory } from './memory.mjs';
import { upscaleNodes, upscaleSource, upscaleWorkflow } from './upscale.mjs';

function needsAudioGuidanceStrength(project) {
  return project.scenes.some((scene, index) => (scene.audioGuidanceScale ?? 1) > 1
    && sceneUsesAudioGuidance(scene) && sceneAudioCoverage(project, index).coveredFrames > 0);
}

export const MODEL_PROFILE = {
  model: {
    dir: 'diffusion_models', loader: 'UNETLoader', input: 'unet_name',
    filenames: ['ltx-2.5-22b-distilled-transformer-comfy-int8-convrot.safetensors'],
  },
  clip: {
    dir: 'text_encoders', loader: 'CLIPLoader', input: 'clip_name',
    filenames: ['gemma4-12b-with-proj-ltx-2.5-comfy-int8-convrot.safetensors'],
  },
  video_vae: {
    dir: 'vae', loader: 'VAELoader', input: 'vae_name',
    filenames: ['ltx-2.5-video-vae-conv-bf16.safetensors', 'ltx-2.5-video-vae-bf16.safetensors'],
  },
  audio_vae: {
    dir: 'vae', loader: 'VAELoader', input: 'vae_name',
    filenames: ['ltx-2.5-audio-vae-bf16.safetensors'],
  },
};

const NODE_NAMES = ['HappyLatentVideo', 'UNETLoader', 'CLIPLoader', 'VAELoader', 'SaveVideo', 'ConcatenateVideo'];
const JOB_ID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
const OUTPUT_FOLDER = 'happylatent/agent';
const MAX_UPLOAD = 256 * 1024 * 1024;

function loopbackUrl(value) {
  const url = new URL(value);
  if (!['http:', 'https:'].includes(url.protocol) ||
      !['127.0.0.1', '[::1]'].includes(url.hostname) ||
      url.username || url.password || url.search || url.hash || url.pathname !== '/') {
    throw new Error('Configure ComfyUI with a numeric loopback origin, e.g. http://127.0.0.1:8188.');
  }
  return url.origin;
}

class HttpError extends Error {
  constructor(route, status, detail) {
    super(`ComfyUI ${route} returned HTTP ${status}${detail ? ': ' + detail : ''}`);
    this.status = status;
  }
}

function serverDetail(body) {
  try {
    const parsed = JSON.parse(body);
    const error = parsed.error;
    const detail = [error?.message ?? (typeof error === 'string' ? error : null), error?.details]
      .filter(Boolean).join(' ');
    const nodeErrors = Object.entries(parsed.node_errors ?? {})
      .map(([id, node]) => `Node ${id}: ${(node.errors ?? []).map(e => e.details || e.message).join('; ')}`);
    return [detail, ...nodeErrors].filter(Boolean).join(' ').slice(0, 1_500);
  } catch {
    return body.trim().slice(0, 1_500);
  }
}

function readJson(file) {
  return readFile(file, 'utf8').then(JSON.parse);
}

async function optionalJson(file) {
  try { return await readJson(file); }
  catch (error) { if (error.code !== 'ENOENT') throw error; return null; }
}

async function writeJson(file, value, { exclusive = false } = {}) {
  await mkdir(dirname(file), { recursive: true, mode: 0o700 });
  const temp = `${file}.${randomUUID()}.tmp`;
  try {
    const stream = await open(temp, 'wx', 0o600);
    try {
      await stream.writeFile(JSON.stringify(value, null, 2) + '\n');
      await stream.sync();
    } finally {
      await stream.close();
    }
    if (exclusive) await link(temp, file);
    else await rename(temp, file);
    return true;
  } catch (error) {
    if (exclusive && error.code === 'EEXIST') return false;
    throw error;
  } finally {
    await rm(temp, { force: true });
  }
}

function stableJobId(projectId, requestId) {
  const hex = createHash('sha256').update(JSON.stringify([projectId, requestId])).digest('hex');
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-4${hex.slice(13, 16)}-a${hex.slice(17, 20)}-${hex.slice(20, 32)}`;
}

function modelNames(info, key) {
  const spec = info?.input?.required?.[key] ?? info?.input?.optional?.[key];
  const choices = spec?.[0] === 'COMBO' ? spec[1]?.options : spec?.[0];
  return Array.isArray(choices) ? choices.filter(name => typeof name === 'string') : [];
}

function findModel(available, filenames) {
  for (const filename of filenames) {
    if (available.includes(filename)) return filename;
    const nested = available.filter(name => name.split(/[\\/]/).at(-1) === filename).sort();
    if (nested.length) return nested[0];
  }
  return null;
}

function outputAsset(history, saveNode, id) {
  const entry = history?.outputs?.[saveNode];
  for (const kind of ['images', 'videos', 'gifs']) {
    for (const item of entry?.[kind] ?? []) {
      if (item?.type === 'output' && item.subfolder?.split(sep).join('/') === OUTPUT_FOLDER &&
          typeof item.filename === 'string' && new RegExp(`^${id}_[0-9]+_\\.mp4$`).test(item.filename)) {
        return { filename: item.filename, subfolder: OUTPUT_FOLDER, type: 'output' };
      }
    }
  }
  return null;
}

function executionError(history) {
  const messages = history?.status?.messages ?? [];
  const error = messages.find(([kind]) => kind === 'execution_error')?.[1];
  if (error) return [error.node_type, error.exception_message].filter(Boolean).join(': ').slice(0, 1_500);
  return 'ComfyUI reported a generation error. See its logs for details.';
}

function ownedItem(item, job) {
  return Array.isArray(item) && (item[3]?.happy_latent_job_id === job.id ||
    (item[1] === job.id && item[3]?.client_id === job.id));
}

async function verifyMp4(file) {
  const handle = await open(file, constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0));
  try {
    const { size } = await handle.stat();
    const header = Buffer.alloc(16);
    let offset = 0;
    let hasMovie = false;
    let hasData = false;
    while (offset < size) {
      const { bytesRead } = await handle.read(header, 0, header.length, offset);
      if (bytesRead < 8) break;
      const type = header.toString('ascii', 4, 8);
      let length = header.readUInt32BE(0);
      const headerLength = length === 1 ? 16 : 8;
      if (length === 1) {
        if (bytesRead < headerLength) break;
        length = Number(header.readBigUInt64BE(8));
      }
      if (length === 0) length = size - offset;
      if (!Number.isSafeInteger(length) || length < headerLength || length > size - offset ||
          (offset === 0 && (type !== 'ftyp' || length < headerLength + 8))) break;
      if (type === 'moov' && length > headerLength) hasMovie = true;
      if (type === 'mdat' && length > headerLength) hasData = true;
      offset += length;
    }
    if (offset !== size || !hasMovie || !hasData) {
      throw new Error('The saved result does not contain a complete MP4 container.');
    }
    return size;
  } finally {
    await handle.close();
  }
}

async function fileDigest(file) {
  const handle = await open(file, constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0));
  try {
    const hash = createHash('sha256');
    for await (const chunk of handle.createReadStream({ autoClose: false })) hash.update(chunk);
    return hash.digest('hex');
  } finally { await handle.close(); }
}

export class Comfy {
  constructor({ comfyUrl = 'http://127.0.0.1:8188', dataDir, assetRoot = process.cwd(), runtimeId, beforeSubmit, beforeTransfer, afterTransfer, monitorProgress = false }) {
    if (runtimeId !== undefined && (typeof runtimeId !== 'string' || !runtimeId.trim() || runtimeId.length > 256)) {
      throw new Error('Runtime identity must be a nonempty string of at most 256 characters.');
    }
    if (beforeSubmit !== undefined && typeof beforeSubmit !== 'function') throw new Error('beforeSubmit must be a function.');
    this.url = loopbackUrl(comfyUrl.replace(/^http:\/\/localhost(?=[:/]|$)/i, 'http://127.0.0.1'));
    this.dataDir = resolve(dataDir);
    this.assetRoot = resolve(assetRoot);
    this.runtimeId = runtimeId;
    for (const [name, callback] of Object.entries({ beforeTransfer, afterTransfer })) {
      if (callback !== undefined && typeof callback !== 'function') throw new Error(`${name} must be a function.`);
    }
    this.beforeSubmit = beforeSubmit;
    this.beforeTransfer = beforeTransfer;
    this.afterTransfer = afterTransfer;
    this.monitorProgress = monitorProgress;
  }

  async response(route, { timeoutMs = 10_000, json, ...options } = {}) {
    const response = await fetch(this.url + route, {
      redirect: 'error',
      signal: AbortSignal.timeout(timeoutMs),
      ...options,
      ...(json === undefined ? {} : {
        method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(json),
      }),
    });
    if (!response.ok) {
      const detail = options.method === 'HEAD' ? '' : serverDetail(await response.text());
      throw new HttpError(route, response.status, detail);
    }
    return response;
  }

  async json(route, options) {
    return (await this.response(route, options)).json();
  }

  async checkSetup({ media = 'video', enhancements: requestedEnhancements } = {}) {
    const enhancements = normalizeEnhancements(requestedEnhancements);
    if (media === 'upscale') {
      if (hasEnhancements(enhancements)) throw new Error('Standalone upscaling always uses 2x spatial upscale and refinement.');
      return this.checkUpscaleSetup();
    }
    if (media === 'music') {
      if (hasEnhancements(enhancements)) throw new Error('Enhancements apply only to video generation.');
      return this.checkMusicSetup();
    }
    if (media === 'image') {
      if (hasEnhancements(enhancements)) throw new Error('Enhancements apply only to video generation.');
      return this.checkImageSetup();
    }
    if (media !== 'video') throw new Error('Setup media must be video, image, music, or upscale.');
    const setup = { comfyUrl: this.url, models: {}, missingNodes: [], missingModels: [] };
    try {
      const results = await Promise.all(NODE_NAMES.map(async name =>
        (await this.json(`/object_info/${name}`))[name]));
      const nodes = Object.fromEntries(NODE_NAMES.map((name, index) => [name, results[index]]));
      setup.missingNodes = NODE_NAMES.filter(name => !nodes[name]);
      if (nodes.HappyLatentVideo && !['model', 'clip', 'video_vae', 'audio_vae', 'project'].every(
        key => nodes.HappyLatentVideo.input?.required?.[key] ?? nodes.HappyLatentVideo.input?.optional?.[key],
      )) {
        return { ...setup, status: 'missing_nodes', reason: 'The installed HappyLatentVideo node has an incompatible input schema.' };
      }
      setup.clips = !!(nodes.HappyLatentVideo?.input?.optional?.render_mode ?? nodes.HappyLatentVideo?.input?.required?.render_mode);
      if (setup.missingNodes.length) {
        return { ...setup, status: 'missing_nodes', reason: `Install compatible ComfyUI and Happy Latent. Missing: ${setup.missingNodes.join(', ')}.` };
      }
      for (const [key, { dir, loader, input, filenames }] of Object.entries(MODEL_PROFILE)) {
        const model = findModel(modelNames(nodes[loader], input), filenames);
        if (model) setup.models[key] = model;
        else setup.missingModels.push({ key, dir, filenames });
      }
      // Optional enhancement readiness must not block ordinary base video jobs.
      const hasUpscale = nodes.HappyLatentVideo.input?.optional?.upscale_model || hasEnhancements(enhancements);
      const loader = hasUpscale
        ? await this.json('/object_info/LatentUpscaleModelLoader').then(result => result.LatentUpscaleModelLoader).catch(() => undefined)
        : undefined;
      const enhancement = enhancementSetup(nodes.HappyLatentVideo, loader, enhancements);
      setup.enhancements = enhancements;
      setup.enhancementCapabilities = enhancement.capabilities;
      Object.assign(setup.models, enhancement.models);
      setup.missingNodes.push(...enhancement.missingNodes);
      setup.missingModels.push(...enhancement.missingModels);
      if (setup.missingNodes.length) return { ...setup, status: 'missing_nodes',
        reason: `The selected video enhancements require compatible nodes: ${setup.missingNodes.join(', ')}. Update ComfyUI and Happy Latent.` };
      if (setup.missingModels.length) {
        const optionalMissing = enhancement.missingModels.length > 0;
        return { ...setup, status: 'missing_models', reason: optionalMissing
          ? 'The selected video enhancements require the listed official LTX 2.5 upscaler files in latent_upscale_models. Install them before rendering; no models are downloaded automatically.'
          : 'The LTX 2.5 Distilled model profile is incomplete. Use check_model_access to review local files and Hugging Face access, or cloud_status for a Runpod runtime.' };
      }
      return { ...setup, status: 'ready' };
    } catch (error) {
      return {
        ...setup, status: 'unreachable',
        reason: `Could not query ComfyUI at ${this.url}: ${error.message}. Start it or check the configured address.`,
      };
    }
  }

  async checkImageSetup() {
    const setup = { comfyUrl: this.url, media: 'image', models: {}, missingNodes: [], missingModels: [] };
    const names = Object.keys(IMAGE_NODE_INPUTS);
    try {
      const results = await Promise.all(names.map(async name => (await this.json(`/object_info/${name}`))[name]));
      const nodes = Object.fromEntries(names.map((name, index) => [name, results[index]]));
      setup.missingNodes = names.filter(name => !nodes[name]);
      if (setup.missingNodes.length) return { ...setup, status: 'missing_nodes', reason: `Install compatible ComfyUI and Happy Latent. Missing: ${setup.missingNodes.join(', ')}.` };
      const incompatible = names.filter(name => IMAGE_NODE_INPUTS[name].some(key =>
        !(nodes[name].input?.required?.[key] ?? nodes[name].input?.optional?.[key])));
      if (!modelNames(nodes.CLIPLoader, 'type').includes('flux2')) incompatible.push('CLIPLoader (flux2)');
      if (incompatible.length) return { ...setup, status: 'missing_nodes', reason: `ComfyUI has incompatible Klein node schemas: ${incompatible.join(', ')}. Update ComfyUI and Happy Latent.` };
      const klein = nodes.HappyLatentKleinImage;
      const components = Object.entries(IMAGE_MODEL_PROFILE);
      const linkedModels = components.every(([, { socket, type }]) =>
        (klein.input?.required?.[socket] ?? klein.input?.optional?.[socket])?.[0] === type);
      const legacyModels = components.every(([key]) => Array.isArray(klein.input?.required?.[key]?.[0]));
      if ((!linkedModels && !legacyModels) ||
          !IMAGE_NODE_INPUTS.HappyLatentKleinImage.every(key => klein.input?.required?.[key]) ||
          klein.input?.required?.count ||
          klein.input?.optional?.reference_framing?.[0] !== 'STRING' ||
          !['reference_1', 'reference_2', 'reference_3', 'reference_4'].every(key => klein.input?.optional?.[key]?.[0] === 'IMAGE') ||
          klein.output?.length !== 1 || klein.output[0] !== 'IMAGE') {
        return { ...setup, status: 'missing_nodes', reason: 'The installed HappyLatentKleinImage node has an incompatible input/output schema.' };
      }
      for (const [key, { dir, filenames, loader, input }] of components) {
        const available = linkedModels ? modelNames(nodes[loader], input) : modelNames(klein, key);
        const model = findModel(available, filenames);
        if (model) setup.models[key] = model;
        else setup.missingModels.push({ key, dir, filenames });
      }
      if (setup.missingModels.length) return { ...setup, status: 'missing_models', reason: 'The Klein 4B profile is incomplete. Install the listed Apache 2.0 image components; the video model profile is independent.' };
      return { ...setup, status: 'ready', ...(linkedModels ? { linkedModels } : {}) };
    } catch (error) {
      return { ...setup, status: 'unreachable', reason: `Could not query ComfyUI at ${this.url}: ${error.message}. Start it or check the configured address.` };
    }
  }

  async checkAssemblySetup() {
    const setup = { comfyUrl: this.url, models: {}, missingNodes: [], missingModels: [], clips: true };
    try {
      for (const name of ['HappyLatentVideo', 'SaveVideo', 'ConcatenateVideo']) {
        const node = (await this.json(`/object_info/${name}`))[name];
        if (!node || name === 'HappyLatentVideo' && !(node.input?.optional?.render_mode ?? node.input?.required?.render_mode)) setup.missingNodes.push(name);
      }
      return { ...setup, status: setup.missingNodes.length ? 'missing_nodes' : 'ready',
        ...(setup.missingNodes.length ? { reason: 'Update Happy Latent and restart ComfyUI to assemble existing video clips.' } : {}) };
    } catch (error) { return { ...setup, status: 'unreachable', reason: error.message }; }
  }

  async checkMusicSetup() {
    const setup = { comfyUrl: this.url, media: 'music', model: 'ACE-Step 1.5 XL Turbo', models: {}, missingNodes: [], missingModels: [] };
    try {
      const names = Object.keys(MUSIC_NODE_INPUTS);
      const results = await Promise.all(names.map(async name => (await this.json(`/object_info/${name}`))[name]));
      const nodes = Object.fromEntries(names.map((name, index) => [name, results[index]]));
      setup.missingNodes = names.filter(name => !nodes[name]);
      if (setup.missingNodes.length) return { ...setup, status: 'missing_nodes', reason: `Update ComfyUI for ACE-Step 1.5 XL Turbo. Missing nodes: ${setup.missingNodes.join(', ')}.` };
      const incompatible = names.filter(name => MUSIC_NODE_INPUTS[name].some(key =>
        !(nodes[name].input?.required?.[key] ?? nodes[name].input?.optional?.[key])));
      if (!modelNames(nodes.DualCLIPLoader, 'type').includes('ace')) incompatible.push('DualCLIPLoader (ace)');
      if (!modelNames(nodes.KSampler, 'sampler_name').includes('euler')) incompatible.push('KSampler (euler)');
      if (!modelNames(nodes.KSampler, 'scheduler').includes('simple')) incompatible.push('KSampler (simple)');
      if (incompatible.length) return { ...setup, status: 'missing_nodes', reason: `ComfyUI has incompatible ACE-Step node schemas: ${incompatible.join(', ')}. Update ComfyUI.` };
      for (const [key, { dir, loader, input, filenames }] of Object.entries(MUSIC_MODEL_PROFILE)) {
        const model = findModel(modelNames(nodes[loader], input), filenames);
        if (model) setup.models[key] = model;
        else setup.missingModels.push({ key, dir, filenames });
      }
      if (setup.missingModels.length) return { ...setup, status: 'missing_models', reason: 'Install the listed ACE-Step 1.5 XL Turbo components on the selected runtime. Use download_models media=music locally or cloud_install_models on a supported Runpod Pod.' };
      return { ...setup, status: 'ready' };
    } catch (error) {
      return { ...setup, status: 'unreachable', reason: `Could not query music readiness at ${this.url}: ${error.message}` };
    }
  }

  async validate(project, { enhancements: requestedEnhancements, mode, sceneIds } = {}) {
    const enhancements = normalizeEnhancements(requestedEnhancements);
    const plan = renderPlan(project, { mode, sceneIds });
    if (!plan.needsModels && hasEnhancements(enhancements)) throw new Error('Assembly uses existing footage. Omit generation enhancements when exporting chosen takes.');
    const setup = plan.needsModels ? await this.checkSetup({ enhancements }) : await this.checkAssemblySetup();
    if ((plan.mode !== 'generate' || project.scenes.some(scene => scene.video)) && !setup.clips && setup.status === 'ready') {
      setup.status = 'missing_nodes'; setup.reason = 'Update Happy Latent and restart ComfyUI to use existing clips or selected generation.';
    }
    const generatedIds = new Set(plan.generated.map(scene => scene.id));
    const generationProject = { ...project, scenes: project.scenes.map(scene => generatedIds.has(scene.id) ? scene : { ...scene, audioGuidance: false }) };
    if (plan.needsModels) await this.checkAudioGuidanceStrength(generationProject, setup);
    const assets = new Map();
    for (const scene of plan.scenes) {
      for (const asset of generatedIds.has(scene.id) ? [scene.image, scene.endImage] : [scene.video?.asset]) {
        if (asset) assets.set(JSON.stringify(asset), asset);
      }
    }
    let start = 0;
    const generatedRanges = project.scenes.map(scene => { const range = [start, start + scene.durationFrames, generatedIds.has(scene.id)]; start = range[1]; return range; });
    for (const segment of project.audioSegments) {
      if (segment.kind === 'file' && segment.asset && generatedRanges.some(([from, to, generated]) => generated && segment.startFrame < to && (segment.endFrame ?? start) > from)) assets.set(JSON.stringify(segment.asset), segment.asset);
    }
    const includedIds = new Set(plan.scenes.map(scene => scene.id));
    const musicSegments = (project.musicSegments ?? []).filter(segment => generatedRanges.some(([from, to], index) =>
      includedIds.has(project.scenes[index].id) && segment.startFrame < to && segment.endFrame > from));
    for (const segment of musicSegments) assets.set(JSON.stringify(segment.asset), segment.asset);
    if (musicSegments.length && ['ready', 'missing_models'].includes(setup.status)) {
      const node = (await this.json('/object_info/HappyLatentMusicMix')).HappyLatentMusicMix;
      if (!node?.input?.required?.plan || !(node.input?.optional?.base_audio ?? node.input?.required?.base_audio)) {
        setup.status = 'missing_nodes'; setup.missingNodes.push('HappyLatentMusicMix');
        setup.reason = 'Update Happy Latent and restart ComfyUI to mix project music while preserving scene audio.';
      }
    }
    const missingAssets = [];
    if (['ready', 'missing_models'].includes(setup.status)) {
      // Cap concurrent lookups when a project has many scenes.
      const entries = [...assets.values()];
      for (let index = 0; index < entries.length; index += 8) {
        await Promise.all(entries.slice(index, index + 8).map(async asset => {
          const params = new URLSearchParams(asset);
          try {
            await this.response(`/happylatent/assets?${params}`, { method: 'HEAD' });
          } catch (error) {
            missingAssets.push({ asset, reason: error.message });
          }
        }));
      }
    }
    return { ready: setup.status === 'ready' && missingAssets.length === 0, setup, missingAssets,
      enhancements, mode: plan.mode, scope: plan.scope, generatedSceneIds: [...generatedIds],
      expected: expectedVideo({ ...project, scenes: plan.scenes }, enhancements) };
  }

  async checkAudioGuidanceStrength(project, setup) {
    if (!needsAudioGuidanceStrength(project) || !['ready', 'missing_models'].includes(setup.status)) return;
    const name = 'HappyLatentAudioGuidance';
    const node = (await this.json(`/object_info/${name}`))[name];
    if (!node?.input?.required?.strength || !node?.input?.required?.model) {
      setup.missingNodes.push(name);
      setup.status = 'missing_nodes';
      setup.reason = 'Audio guidance strength requires the updated Happy Latent node. Update Happy Latent and restart ComfyUI before rendering this project.';
    }
  }

  async uploadAsset(kind, userPath) {
    if (!['image', 'audio', 'video'].includes(kind)) throw new Error('Asset kind must be image, audio, or video.');
    const root = await realpath(this.assetRoot);
    const file = await realpath(resolve(root, userPath));
    const contained = relative(root, file);
    if (!contained || isAbsolute(contained) || contained === '..' || contained.startsWith(`..${sep}`)) {
      throw new Error('Choose a file inside the configured Happy Latent workspace.');
    }
    return this.#uploadFile(kind, file);
  }

  uploadGeneratedSpeech(file) {
    return this.#uploadFile('audio', file);
  }

  async importMemoryReference(selector) {
    const memory = new Memory({ stateDir: this.dataDir, workspaceDir: this.assetRoot });
    const file = await memory.resolveReference(selector);
    return this.#uploadFile('image', file, basename(file).split('.')[0]);
  }

  async confirmTransfer(manifest) {
    if (this.runtimeId === undefined) return;
    if (!this.beforeTransfer) throw new Error('Cloud data transfer requires client confirmation. Reconnect using a Happy Latent client that supports approval.');
    if (await this.beforeTransfer(structuredClone(manifest)) !== true) throw new Error('Cloud data transfer was not approved.');
  }

  generationTransfer(job) {
    const payload = { prompt: job.prompt, prompt_id: job.id, client_id: job.id,
      extra_data: { happy_latent_job_id: job.id } };
    const bytes = Buffer.from(JSON.stringify(payload));
    return { operation: 'generation', runtimeId: this.runtimeId, jobId: job.id,
      media: job.media ?? 'video', payloadBytes: bytes.length,
      sha256: createHash('sha256').update(bytes).digest('hex'),
      content: job.transferContent ?? {}, destination: '/prompt' };
  }

  async #uploadFile(kind, file, expectedDigest) {
    let handle = await open(file, constants.O_RDONLY | constants.O_NONBLOCK | (constants.O_NOFOLLOW ?? 0));
    let staging;
    try {
      let info = await handle.stat();
      if (!info.isFile() || !info.size || info.size > MAX_UPLOAD) {
        throw new Error('An asset must be a nonempty regular file up to 256 MiB.');
      }
      const uploadName = basename(file).replace(/[\x00-\x1f\x7f"\\]/g, "_").slice(0, 255);
      // Freeze the bytes before prompting. Editing the original file while
      // the user reviews the request cannot change what gets transmitted.
      const snapshots = join(this.dataDir, 'transfer-snapshots');
      await mkdir(snapshots, { recursive: true, mode: 0o700 });
      staging = await mkdtemp(join(snapshots, 'upload-'));
      const snapshot = join(staging, 'asset');
      await pipeline(handle.createReadStream({ start: 0, end: info.size - 1, autoClose: false }),
        createWriteStream(snapshot, { flags: 'wx', mode: 0o600 }));
      await handle.close();
      handle = await open(snapshot, constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0));
      const snapshotInfo = await handle.stat();
      if (snapshotInfo.size !== info.size) throw new Error('The source file changed while preparing the upload. Retry to review its current contents.');
      const sha256 = expectedDigest || this.runtimeId !== undefined ? await fileDigest(snapshot) : undefined;
      if (expectedDigest && sha256 !== expectedDigest) throw new Error('Stored reference image has changed.');
      if (this.runtimeId !== undefined) {
        await this.confirmTransfer({ operation: 'upload', runtimeId: this.runtimeId,
          files: [{ name: uploadName, source: file, kind, bytes: info.size,
            sha256 }],
          destination: '/workspace/input/happylatent' });
      }
      const boundary = randomUUID();
      const header = Buffer.from(`--${boundary}\r\nContent-Disposition: form-data; name="file"; filename="${uploadName}"\r\nContent-Type: application/octet-stream\r\n\r\n`);
      const footer = Buffer.from(`\r\n--${boundary}--\r\n`);
      const data = handle.createReadStream({ start: 0, end: info.size - 1, autoClose: false });
      const body = Readable.from((async function* () {
        yield header;
        yield* data;
        yield footer;
      })());
      try {
        const result = await this.json(`/happylatent/assets?kind=${kind}`, {
          method: 'POST', body, duplex: 'half', timeoutMs: 180_000,
          headers: {
            'Content-Type': `multipart/form-data; boundary=${boundary}`,
            'Content-Length': String(header.length + info.size + footer.length),
          },
        });
        await this.afterTransfer?.({ direction: 'upload', kind, asset: result.asset, clip: result.clip });
        const preview = await assetPreview({ kind, file: join(staging, 'asset'), sourcePath: file, stateDir: this.dataDir });
        return { ...result, preview };
      } finally {
        body.destroy();
        data.destroy();
      }
    } finally {
      await handle.close();
      if (staging) await rm(staging, { recursive: true, force: true });
    }
  }

  modelInputs(project, models, api, prefix, enhancements = normalizeEnhancements()) {
    const editor = Object.values(api).find(node => node.class_type === 'HappyLatentVideo');
    for (const [key, { input }] of Object.entries(MODEL_PROFILE)) api[editor.inputs[key][0]].inputs[input] = models[key];
    editor.inputs.project = JSON.stringify(project);
    applyEnhancementInputs(api, editor, models, enhancements);
    const saveNode = Object.keys(api).find(id => api[id].class_type === 'SaveVideo');
    api[saveNode].inputs.filename_prefix = prefix;
    return saveNode;
  }

  async exportWorkflow(project, { format = 'ui', enhancements: requestedEnhancements, mode, sceneIds } = {}) {
    if (!['ui', 'api'].includes(format)) throw new Error('Workflow format must be ui or api.');
    const enhancements = normalizeEnhancements(requestedEnhancements);
    const plan = renderPlan(project, { mode, sceneIds });
    if (!plan.needsModels && hasEnhancements(enhancements)) throw new Error('Assembly uses existing footage. Omit generation enhancements when exporting chosen takes.');
    const setup = plan.needsModels ? await this.checkSetup({ enhancements }) : await this.checkAssemblySetup();
    if (plan.needsModels) await this.checkAudioGuidanceStrength(project, setup);
    if ((plan.mode !== 'generate' || !plan.needsModels || project.scenes.some(scene => scene.video)) && !setup.clips) throw new Error('Update Happy Latent and restart ComfyUI to export workflows using existing clips or selected generation.');
    if ((hasEnhancements(enhancements) || needsAudioGuidanceStrength(project)) && setup.status !== 'ready') {
      throw new Error(setup.reason ?? 'Selected video enhancements are not ready.');
    }
    const models = plan.needsModels ? Object.fromEntries(Object.entries(MODEL_PROFILE).map(([key, { filenames }]) =>
      [key, setup.models[key] ?? filenames[0]])) : {};
    for (const key of ['spatialUpscale', 'temporalUpscale']) if (setup.models[key]) models[key] = setup.models[key];
    const directory = join(this.dataDir, 'exports');
    const file = join(directory, `${randomUUID()}-${format}.json`);
    const api = plan.needsModels ? await readFile(new URL('../resources/happylatent-api.json', import.meta.url), 'utf8').then(JSON.parse)
      : assemblyWorkflow(project, 'happylatent/sequence', plan);
    if (plan.needsModels) this.modelInputs(project, models, api, 'happylatent/sequence', enhancements);
    if (setup.clips) Object.assign(Object.values(api).find(node => node.class_type === 'HappyLatentVideo').inputs,
      { render_mode: plan.mode, scene_ids: JSON.stringify(plan.sceneIds), run_id: '' });
    if (format === 'api') await writeJson(file, api);
    else {
      const ui = await readFile(new URL('../resources/happylatent.json', import.meta.url), 'utf8').then(JSON.parse);
      renderUi(ui, api);
      for (const node of ui.nodes) {
        const apiNode = api[String(node.id)];
        if (!apiNode || apiNode.class_type !== node.type) throw new Error('Bundled workflow examples use different node IDs.');
        const named = node.widgets_values_named;
        if (!named) continue;
        // LiteGraph widgets use both ordered storage and a name lookup.
        for (const [index, name] of Object.keys(named).entries()) {
          if (Object.hasOwn(apiNode.inputs, name) && !Array.isArray(apiNode.inputs[name])) {
            named[name] = apiNode.inputs[name];
            node.widgets_values[index] = named[name];
          }
        }
      }
      applyEnhancementUi(ui, api, enhancements);
      await writeJson(file, ui);
    }
    return { path: file, format, models, enhancements, mode: plan.mode, scope: plan.scope, expected: expectedVideo({ ...project, scenes: plan.scenes }, enhancements),
      assets: 'Asset references resolve on the current ComfyUI installation.' };
  }

  jobPath(id, kind) {
    if (!JOB_ID.test(id)) throw new Error('Job ID must be a Happy Latent job UUID.');
    return join(this.dataDir, 'jobs', id, `${kind}.json`);
  }

  async readJob(id) {
    const job = await optionalJson(this.jobPath(id, 'job'));
    if (!job) throw new Error(`No Happy Latent job found for ${id}.`);
    if (Object.hasOwn(job, 'runtimeId')) {
      if (this.runtimeId === undefined || job.runtimeId !== this.runtimeId) {
        throw new Error(`Job ${id} belongs to runtime ${job.runtimeId}. Reconnect that runtime to follow this job.`);
      }
    } else if (this.runtimeId !== undefined || job.comfyUrl !== this.url) {
      throw new Error(`Job ${id} belongs to local ComfyUI at ${job.comfyUrl}. Reconnect that local runtime to follow this job.`);
    }
    return job;
  }

  async generate(project, { revision, requestId, enhancements: requestedEnhancements, mode, sceneIds }) {
    if (typeof requestId !== 'string' || !requestId.trim() || requestId.length > 128) {
      throw new Error('Supply a requestId (1–128 characters) and reuse it for retries.');
    }
    const enhancements = normalizeEnhancements(requestedEnhancements);
    const plan = renderPlan(project, { mode, sceneIds });
    const id = stableJobId(project.id, requestId);
    // Keep legacy/default request digests stable so old jobs remain retryable.
    const identity = hasEnhancements(enhancements) ? [revision, project, enhancements] : [revision, project];
    if (plan.mode !== 'generate') identity.push({ mode: plan.mode, sceneIds: plan.sceneIds });
    const digest = createHash('sha256').update(JSON.stringify(identity)).digest('hex');
    const jobFile = this.jobPath(id, 'job');
    const prior = await optionalJson(jobFile);
    const existing = async () => {
      const job = await this.readJob(id);
      if (job.digest !== digest) throw new Error('This requestId is already bound to another project revision or enhancement settings. Use a new requestId for a new render.');
      return this.getJob(id);
    };
    if (prior) return existing();

    const { ready, setup, missingAssets, expected, generatedSceneIds } = await this.validate(project, { enhancements, mode: plan.mode, sceneIds: plan.sceneIds.length ? plan.sceneIds : undefined });
    if (!ready) throw new Error(setup.reason ?? `Missing media: ${missingAssets.map(item => item.asset.filename).join(', ')}.`);
    const prompt = plan.needsModels
      ? await readFile(new URL('../resources/happylatent-api.json', import.meta.url), 'utf8').then(JSON.parse)
      : assemblyWorkflow(project, `${OUTPUT_FOLDER}/${id}`, { ...plan, runId: id });
    const saveNode = plan.needsModels ? this.modelInputs(project, setup.models, prompt, `${OUTPUT_FOLDER}/${id}`, enhancements) : '6';
    if (setup.clips) Object.assign(Object.values(prompt).find(node => node.class_type === 'HappyLatentVideo').inputs,
      { render_mode: plan.mode, scene_ids: JSON.stringify(plan.sceneIds), run_id: id });
    // Existing requests return above without this guard, so an expired budget
    // never prevents following an already submitted job.
    await this.beforeSubmit?.();
    const job = {
      id, projectId: project.id, projectTitle: project.title, revision, requestId,
      comfyUrl: this.url, createdAt: new Date().toISOString(), digest, saveNode, prompt,
      ...(this.runtimeId !== undefined ? { runtimeId: this.runtimeId } : {}),
      enhancements, expected, transferContent: structuredClone(project),
      ...(this.runtimeId && plan.scenes.length === 1 && generatedSceneIds.length === 1 ? {
        benchmarkShot: { width: project.width, height: project.height, fps: project.fps, frames: expected.frames },
      } : {}),
      ...(setup.clips ? { clips: true, mode: plan.mode, scope: plan.scope, sceneIds: plan.sceneIds } : {}),
    };
    await this.confirmTransfer(this.generationTransfer(job));
    if (!await writeJson(jobFile, job, { exclusive: true })) return existing();

    return this.#submitJob(job);
  }

  async listClips({ projectId, runId } = {}) {
    const query = new URLSearchParams({ ...(projectId ? { projectId } : {}), ...(runId ? { runId } : {}) });
    const response = await this.json(`/happylatent/clips?${query}`);
    if (!Array.isArray(response.clips)) throw new Error('The backend returned an invalid clip library.');
    return { clips: response.clips.map(videoTake), runtimeId: this.runtimeId ?? null,
      note: 'Clips belong to the selected runtime. Adding or choosing a clip does not generate video.' };
  }

  async getClip(id) {
    if (typeof id !== 'string' || !/^[a-zA-Z0-9_-]{1,128}$/.test(id)) throw new Error('Invalid clip ID.');
    const response = await this.json(`/happylatent/clips/${encodeURIComponent(id)}`);
    const clip = videoTake(response.clip);
    if (clip.id !== id) throw new Error('The backend returned a mismatched clip.');
    return { clip, ...(response.recipe ? { recipe: response.recipe } : {}) };
  }

  async jobClips(job) {
    if (!job.clips) return undefined;
    const path = this.jobPath(job.id, 'clips');
    try {
      const manifest = clipManifest(await this.json(`/happylatent/runs/${job.id}`), job);
      await writeJson(path, manifest);
      return manifest;
    } catch (error) {
      const cached = await optionalJson(path);
      if (cached) return clipManifest(cached, job);
      return { runId: job.id, projectId: job.projectId, scope: job.scope, clips: [], unavailable: error.message };
    }
  }

  async generateImage(input, { requestId }) {
    const request = imageRequest(input);
    if (typeof requestId !== 'string' || !requestId.trim() || requestId.length > 128) throw new Error('Supply a requestId (1–128 characters) and reuse it for retries.');
    // A dedicated namespace keeps image request IDs separate from video projects.
    const id = stableJobId('klein-image-v1', requestId);
    const digest = createHash('sha256').update(JSON.stringify(request)).digest('hex');
    const jobFile = this.jobPath(id, 'job');
    const prior = await optionalJson(jobFile);
    const existing = async () => {
      const job = await this.readJob(id);
      // The original digest included count immediately before references.
      const { references, ...settings } = request;
      const legacyDigest = job.expected?.count === 1 && references.every(reference => !reference.crop)
        ? createHash('sha256').update(JSON.stringify({ ...settings, count: 1, references })).digest('hex')
        : undefined;
      if (job.media !== 'image' || (job.digest !== digest && !(legacyDigest && job.digest === legacyDigest))) {
        throw new Error('This requestId is already bound to another image request. Use a new requestId for a new image.');
      }
      return this.getJob(id);
    };
    if (prior) return existing();
    const setup = await this.checkImageSetup();
    if (setup.status !== 'ready') throw new Error(setup.reason);
    for (const { filename, subfolder, type } of request.references) {
      try { await this.response(`/happylatent/assets?${new URLSearchParams({ filename, subfolder, type })}`, { method: 'HEAD' }); }
      catch (error) { throw new Error(`Image reference ${filename} is unavailable: ${error.message}`); }
    }
    await this.beforeSubmit?.();
    const job = {
      id, media: 'image', requestId, comfyUrl: this.url, createdAt: new Date().toISOString(), digest,
      ...(this.runtimeId !== undefined ? { runtimeId: this.runtimeId } : {}),
      saveNode: 'save', prompt: imageWorkflow(request, setup.models, `${OUTPUT_FOLDER}/${id}`, { linkedModels: setup.linkedModels }),
      expected: { width: request.width, height: request.height }, transferContent: structuredClone(request),
    };
    await this.confirmTransfer(this.generationTransfer(job));
    if (!await writeJson(jobFile, job, { exclusive: true })) return existing();
    return this.#submitJob(job);
  }

  async generateMusic(input, { requestId }) {
    const request = musicRequest(input);
    if (typeof requestId !== 'string' || !requestId.trim() || requestId.length > 128) throw new Error('Supply a requestId (1–128 characters) and reuse it for retries.');
    const id = stableJobId('ace-step-1.5-xl-turbo', requestId);
    const digest = createHash('sha256').update(JSON.stringify(request)).digest('hex');
    const jobFile = this.jobPath(id, 'job');
    const existing = async () => {
      const job = await this.readJob(id);
      if (job.media !== 'music' || job.digest !== digest) throw new Error('This requestId is already bound to another music request. Use a new requestId for a new song.');
      return this.getJob(id);
    };
    if (await optionalJson(jobFile)) return existing();
    const setup = await this.checkMusicSetup();
    if (setup.status !== 'ready') throw new Error(setup.reason);
    await this.beforeSubmit?.();
    const job = { id, media: 'music', requestId, comfyUrl: this.url, createdAt: new Date().toISOString(), digest,
      ...(this.runtimeId !== undefined ? { runtimeId: this.runtimeId } : {}),
      saveNode: 'save', prompt: musicWorkflow(request, setup.models, `${OUTPUT_FOLDER}/${id}`),
      expected: { durationSeconds: request.durationSeconds }, transferContent: structuredClone(request),
    };
    await this.confirmTransfer(this.generationTransfer(job));
    if (!await writeJson(jobFile, job, { exclusive: true })) return existing();
    return this.#submitJob(job);
  }

  async analyzeMusic({ asset, jobId, startSeconds, endSeconds, targetDurationSeconds }) {
    if (Boolean(asset) === Boolean(jobId)) throw new Error('Choose exactly one imported audio asset or completed music jobId.');
    if (jobId) {
      const job = await this.readJob(jobId);
      if (job.media !== 'music') throw new Error('Choose a completed music job, or import an audio file.');
      const state = await this.#completedState(job);
      asset = state.outputs[0];
    } else asset = validateAsset(asset);
    const options = { asset };
    for (const [key, value] of Object.entries({ startSeconds, endSeconds, targetDurationSeconds })) {
      if (value === undefined) continue;
      if (!Number.isFinite(value) || value < 0 || key === 'targetDurationSeconds' && value === 0) throw new Error(`Invalid ${key}.`);
      options[key] = value;
    }
    if (endSeconds !== undefined && endSeconds <= (startSeconds ?? 0)) throw new Error('Analysis end must follow its start.');
    return this.json('/happylatent/music/analyze', { json: options, timeoutMs: 180_000 });
  }

  async importGeneratedMusic(id) {
    const job = await this.readJob(id);
    if (job.media !== 'music') throw new Error('Choose a completed music job.');
    const state = await this.#completedState(job);
    const result = await this.getMusicResult(job, state, { preview: false });
    return this.#uploadFile('audio', result.path);
  }

  async checkUpscaleSetup() {
    const setup = { media: 'upscale', comfyUrl: this.url, missingNodes: [], missingModels: [], models: {} };
    const profile = { model: MODEL_PROFILE.model, clip: MODEL_PROFILE.clip, video_vae: MODEL_PROFILE.video_vae,
      spatialUpscale: { dir: 'latent_upscale_models', loader: 'LatentUpscaleModelLoader', input: 'model_name',
        filenames: [UPSCALE_MODELS.spatialUpscale.filename] } };
    try {
      const names = Object.keys(upscaleNodes);
      const nodes = await this.json('/object_info');
      setup.missingNodes = names.filter(name => !nodes[name] || upscaleNodes[name].some(key =>
        !(nodes[name].input?.required?.[key] ?? nodes[name].input?.optional?.[key])));
      if (setup.missingNodes.length) return { ...setup, status: 'missing_nodes',
        reason: `Update Happy Latent and ComfyUI on the selected runtime. Incompatible or missing: ${setup.missingNodes.join(', ')}.` };
      for (const [key, { dir, loader, input, filenames }] of Object.entries(profile)) {
        const model = findModel(modelNames(nodes[loader], input), filenames);
        if (model) setup.models[key] = model;
        else setup.missingModels.push({ key, dir, filenames });
      }
      return setup.missingModels.length ? { ...setup, status: 'missing_models',
        reason: 'Install the listed LTX 2.5 video and spatial upscaling models on the selected runtime.' } : { ...setup, status: 'ready' };
    } catch (error) {
      return { ...setup, status: 'unreachable', reason: `Could not check upscale readiness: ${error.message}` };
    }
  }

  async upscaleVideo(clipId, { requestId, prompt } = {}) {
    if (typeof clipId !== 'string' || !/^[a-f0-9]{32}$/.test(clipId)) throw new Error('Choose a saved take by its clipId.');
    if (typeof requestId !== 'string' || !requestId.trim() || requestId.length > 128) {
      throw new Error('Supply a requestId (1–128 characters) and reuse it for exact retries.');
    }
    if (prompt !== undefined && (typeof prompt !== 'string' || !prompt.trim() || prompt.length > 8000)) {
      throw new Error('Refinement prompt must contain 1–8000 characters.');
    }
    const request = { clipId, prompt: prompt?.trim() ?? 'Preserve the source framing, motion and appearance.' };
    const id = stableJobId('ltx-spatial-upscale-v1', requestId);
    const digest = createHash('sha256').update(JSON.stringify(request)).digest('hex');
    const jobFile = this.jobPath(id, 'job');
    const existing = async () => {
      const job = await this.readJob(id);
      if (job.operation !== 'upscale' || job.digest !== digest) {
        throw new Error('This requestId is already bound to another upscale request.');
      }
      return this.getJob(id);
    };
    if (await optionalJson(jobFile)) return existing();

    const { clip } = await this.getClip(clipId);
    const expected = upscaleSource(clip);
    const setup = await this.checkUpscaleSetup();
    if (setup.status !== 'ready') throw new Error(setup.reason);
    await this.response(`/happylatent/assets?${new URLSearchParams(clip.asset)}`, { method: 'HEAD' });
    await this.beforeSubmit?.();
    const projectId = clip.projectId || 'video-upscale';
    const job = { id, media: 'video', operation: 'upscale', sourceClipId: clip.id, projectId,
      projectTitle: `${clip.name || 'Video'} · AI upscale`, requestId, digest,
      comfyUrl: this.url, createdAt: new Date().toISOString(), saveNode: 'save',
      ...(this.runtimeId !== undefined ? { runtimeId: this.runtimeId } : {}),
      prompt: upscaleWorkflow(clip, setup.models, { runId: id, projectId, prefix: `${OUTPUT_FOLDER}/${id}`, prompt: request.prompt }),
      expected, clips: true, mode: 'upscale', scope: 'selection', sceneIds: clip.sceneId ? [clip.sceneId] : [],
      transferContent: { operation: 'upscale', ...request, source: clip.asset, output: expected } };
    await this.confirmTransfer(this.generationTransfer(job));
    if (!await writeJson(jobFile, job, { exclusive: true })) return existing();
    return this.#submitJob(job);
  }

  async #submitJob(job) {
    const { id, prompt } = job;
    // Attach observation before the final budget guard so connection setup does
    // not delay submission after that check. It never changes or resubmits work.
    if (this.monitorProgress) await ensureJobProgress(job, { dataDir: this.dataDir, url: this.url }).catch(() => null);
    // A lease/deadline can expire while the snapshot is being saved. Record a
    // definite failure before any network submission, rather than classifying
    // this local refusal as an uncertain request or polling a nonexistent job.
    // The caller confirms this exact in-memory job before saving it.
    // Keep submission private so it cannot bypass that one-transfer approval.
    try {
      await this.beforeSubmit?.();
    } catch (error) {
      const failure = { status: 'failed', submitted: false,
        reason: `Generation was not submitted: ${error?.message ?? String(error)}` };
      await writeJson(this.jobPath(id, 'terminal'), failure, { exclusive: true });
      return this.observedJob(job, failure);
    }
    // Save the snapshot before sending anything. If the process or connection
    // dies mid-request, retries reconcile the job by ID and never re-submit it.
    let submission;
    try {
      const queued = await this.json('/prompt', {
        timeoutMs: 30_000,
        json: { prompt, prompt_id: id, client_id: id, extra_data: { happy_latent_job_id: id } },
      });
      if (!JOB_ID.test(queued.prompt_id)) throw new Error('ComfyUI did not return a prompt ID.');
      submission = { promptId: queued.prompt_id };
    } catch (error) {
      submission = error.status === 400
        ? { status: 'failed', reason: error.message }
        : { status: 'unknown', reason: `Submission may have reached ComfyUI: ${error.message}` };
    }
    await writeJson(this.jobPath(id, 'submission'), submission);
    return this.observedJob(job, { status: 'queued', ...submission });
  }

  async observedJob(job, state) {
    const result = this.publicJob(job, state);
    if (state.status === 'failed') result.failure = explainGenerationFailure(state.reason);
    if (!this.monitorProgress) return result;
    try {
      const progress = ['completed', 'failed', 'cancelled'].includes(state.status)
        ? await stopJobProgress(this.dataDir, job, state)
        : await ensureJobProgress(job, { dataDir: this.dataDir, url: this.url, promptId: state.promptId ?? job.id });
      result.progress = progress ?? { connection: 'unavailable', estimatedRemainingSeconds: null,
        note: 'Detailed progress is unavailable; the job status still comes from ComfyUI.' };
      if (state.status === 'failed' && progress?.failure) result.failure = progress.failure;
    } catch {
      result.progress = { connection: 'unavailable', estimatedRemainingSeconds: null,
        note: 'Detailed progress could not be read; the job status still comes from ComfyUI.' };
    }
    return result;
  }

  publicJob(job, state) {
    const { id, projectId, projectTitle, revision, requestId, createdAt, expected } = job;
    return { id, projectId, projectTitle, revision, requestId, createdAt, expected,
      ...(job.operation && job.sourceClipId ? { media: 'video', operation: job.operation, sourceClipId: job.sourceClipId } : {}),
      ...(job.runtimeId !== undefined ? { runtimeId: job.runtimeId } : {}),
      ...(job.enhancements ? { enhancements: job.enhancements } : {}),
      ...(job.clips ? { mode: job.mode, scope: job.scope, sceneIds: job.sceneIds } : {}),
      ...(['image', 'music'].includes(job.media) ? { media: job.media } : {}), ...state };
  }

  async jobState(job) {
    const id = job.id;
    const terminal = await optionalJson(this.jobPath(id, 'terminal'));
    if (terminal) return terminal;
    const submission = await optionalJson(this.jobPath(id, 'submission'));
    if (submission?.status === 'failed') return submission;
    const promptId = submission?.promptId ?? id;
    let history;
    let foundId = promptId;
    let queue;
    try {
      history = (await this.json(`/history/${promptId}`))[promptId];
      if (!history) {
        queue = await this.json('/queue');
        for (const [field, status] of [['queue_running', 'running'], ['queue_pending', 'queued']]) {
          const items = queue[field] ?? [];
          const index = items.findIndex(item => item[1] === submission?.promptId || ownedItem(item, job));
          if (index !== -1) {
            return { status, promptId: items[index][1], ...(status === 'queued' ? { queuePosition: index + 1 } : {}) };
          }
        }
        // The job may have completed between the two requests.
        history = (await this.json(`/history/${promptId}`))[promptId];
      }
      if (!history && !submission?.promptId) {
        const recent = await this.json('/history?max_items=30');
        const matched = Object.entries(recent).find(([, record]) => ownedItem(record?.prompt, job));
        if (matched) [foundId, history] = matched;
      }
    } catch (error) {
      return { status: 'unknown', promptId, reason: `Could not query ComfyUI: ${error.message}` };
    }
    if (!history) {
      const status = !submission && Date.now() - Date.parse(job.createdAt) < 30_000 ? 'submitting' : 'unknown';
      return {
        status, promptId,
        reason: submission?.reason ?? 'ComfyUI has no queue or history entry. Check its logs before starting a new render.',
      };
    }
    const output = ['image', 'music'].includes(job.media) ? null : outputAsset(history, job.saveNode, id);
    const outputs = job.media === 'music' ? musicOutputs(history, job, OUTPUT_FOLDER)
      : job.media === 'image' ? imageOutputs(history, job, OUTPUT_FOLDER) : null;
    let outcome;
    if (history.status?.messages?.some(([kind]) => kind === 'execution_interrupted')) {
      outcome = { status: 'cancelled', promptId: foundId };
    } else if (history.status?.status_str === 'error') {
      outcome = { status: 'failed', promptId: foundId, reason: executionError(history) };
    } else if (history.status?.completed && (output || outputs)) {
      outcome = { status: 'completed', promptId: foundId, ...(outputs ? { outputs } : { output }) };
    } else if (history.status?.completed) {
      outcome = { status: 'failed', promptId: foundId, reason: job.media === 'music'
        ? 'ComfyUI completed the prompt but SaveAudio did not return the expected FLAC output.' : job.media === 'image'
        ? 'ComfyUI completed the prompt but SaveImage did not return the expected PNG output.'
        : 'ComfyUI completed the prompt but SaveVideo did not return the expected MP4.' };
    } else {
      return { status: 'unknown', promptId: foundId, reason: 'ComfyUI history does not record a final state.' };
    }
    await writeJson(this.jobPath(id, 'terminal'), outcome, { exclusive: true });
    return outcome;
  }

  async getJob(id) {
    const job = await this.readJob(id);
    const result = await this.observedJob(job, await this.jobState(job));
    const manifest = await this.jobClips(job);
    return manifest ? { ...result, clips: manifest.clips, ...(manifest.unavailable ? { clipsUnavailable: manifest.unavailable } : {}) } : result;
  }

  async cancelJob(id) {
    const job = await this.readJob(id);
    const current = await this.jobState(job);
    if (!['queued', 'running'].includes(current.status)) return this.observedJob(job, current);
    let cancellation;
    try {
      // Use ComfyUI's atomic ID-scoped cancellation if available. Older
      // installations should not fall back to the global interrupt route.
      cancellation = await this.json(`/api/jobs/${current.promptId}/cancel`, { json: {} });
    } catch (error) {
      if (![404, 405].includes(error.status)) throw error;
      throw new Error('This version of ComfyUI does not support scoped job cancellation. Use its job controls.');
    }
    if (!cancellation.cancelled || current.status === 'running') return this.getJob(id);
    // A job can go from pending to running during the cancel request. Confirm
    // it actually left the queue before marking it cancelled on our side.
    const state = await this.jobState(job);
    if (state.status !== 'unknown' || !state.reason?.startsWith('ComfyUI has no queue')) {
      return this.observedJob(job, state);
    }
    const terminal = { status: 'cancelled', promptId: current.promptId };
    if (!await writeJson(this.jobPath(id, 'terminal'), terminal, { exclusive: true })) return this.getJob(id);
    return this.observedJob(job, terminal);
  }

  async #completedState(job) {
    const state = await this.jobState(job);
    if (this.monitorProgress && ['completed', 'failed', 'cancelled'].includes(state.status)) {
      await stopJobProgress(this.dataDir, job, state).catch(() => null);
    }
    if (state.status !== 'completed') throw new Error(`Job ${job.id} is ${state.status}. ${state.reason ?? ''}`.trim());
    return state;
  }

  async importGeneratedImage(id, index = 0) {
    const job = await this.readJob(id);
    if (job.media !== 'image') throw new Error(`Job ${id} is a video job. Choose an image job.`);
    const { outputs } = await this.#completedState(job);
    if (!Number.isInteger(index) || index < 0 || index >= outputs.length) {
      throw new Error(`Image index must be between 0 and ${outputs.length - 1} for this job.`);
    }
    const image = await this.#cacheImageResult(job, outputs[index], index);
    return this.#uploadFile('image', image.path);
  }

  async getResult(id) {
    const job = await this.readJob(id);
    const state = await this.#completedState(job);
    if (job.media === 'image') return this.getImageResult(job, state);
    if (job.media === 'music') return this.getMusicResult(job, state);
    let transferMs = 0;
    let transfers = 0;
    const measure = ms => { transferMs += ms; transfers++; };
    const full = await this.#cacheVideoResult(state.output, `${id}.mp4`, measure);
    const manifest = await this.jobClips(job);
    const clips = [];
    for (const clip of manifest?.clips ?? []) clips.push({ ...clip,
      ...await this.#cacheVideoResult(clip.asset, `${id}-clip-${clip.id}.mp4`, measure) });
    let benchmarkTiming;
    if (job.benchmarkShot) {
      const completeTransfer = transfers === 1 + clips.length && !manifest?.unavailable;
      benchmarkTiming = await this.#videoTiming(job, completeTransfer ? transferMs : undefined).catch(() => undefined);
    }
    const timing = benchmarkTiming ? { benchmarkTiming } : {};
    if (!manifest) return { jobId: id, ...full, expected: job.expected, ...timing };
    return { jobId: id, ...full, expected: job.expected, scope: manifest.scope, clips, ...timing,
      ...(job.operation && job.sourceClipId ? { operation: job.operation, sourceClipId: job.sourceClipId } : {}),
      ...(manifest.unavailable ? { clipsUnavailable: manifest.unavailable } : {}),
      nextStep: 'Use edit_project choose_take for the scenes to keep, then generate_video with sceneIds for new takes, or export_video to assemble. Saved project revisions are never changed automatically.' };
  }

  async #videoTiming(job, transferMs) {
    const path = this.jobPath(job.id, 'video-timing');
    const saved = await optionalJson(path);
    if (saved || transferMs === undefined) return saved;
    if (!job.enhancements?.spatialUpscale || !job.enhancements.refine || job.enhancements.temporalUpscale) return;
    const progress = await readJobProgress(this.dataDir, job);
    const timing = progress?.timing;
    const renderMs = Date.parse(progress?.finishedAt) - Date.parse(progress?.startedAt);
    if (progress?.state !== 'completed' || !timing?.completedOnSocket || timing.interrupted ||
        !timing.sampled || !timing.refined || timing.refinementMs <= 0 || renderMs <= timing.refinementMs) return;
    const measured = {
      runtimeId: job.runtimeId, ...job.benchmarkShot, enhancements: job.enhancements,
      renderSeconds: renderMs / 1000, refinementSeconds: timing.refinementMs / 1000,
      retrievalSeconds: Math.max(0.001, transferMs / 1000),
    };
    return await writeJson(path, measured, { exclusive: true }) ? measured : optionalJson(path);
  }

  async #cacheVideoResult(asset, name, measure) {
    const directory = join(this.dataDir, 'results');
    const file = join(directory, name);
    await mkdir(directory, { recursive: true, mode: 0o700 });
    let bytes;
    try { bytes = await verifyMp4(file); }
    catch (error) {
      if (error.code !== 'ENOENT') throw error;
      const temp = `${file}.${randomUUID()}.tmp`;
      try {
        const started = performance.now();
        const params = new URLSearchParams(asset);
        const response = await this.response(`/view?${params}`, { timeoutMs: 180_000 });
        await pipeline(Readable.fromWeb(response.body), createWriteStream(temp, { flags: 'wx', mode: 0o600 }));
        bytes = await verifyMp4(temp);
        await rename(temp, file);
        measure?.(performance.now() - started);
      } finally {
        await rm(temp, { force: true });
      }
    }
    await this.afterTransfer?.({ direction: 'download', asset, path: file, bytes,
      sha256: await fileDigest(file) });
    return { path: file, bytes, mediaType: 'video/mp4' };
  }

  async getImageResult(job, state) {
    const images = [];
    for (const [index, asset] of state.outputs.entries()) {
      images.push(await this.#cacheImageResult(job, asset, index));
    }
    const request = job.transferContent ?? job.prompt?.image?.inputs ?? {};
    return { jobId: job.id, images, prompt: request.prompt,
      settings: { width: job.expected.width, height: job.expected.height, seed: request.seed } };
  }

  async getMusicResult(job, state, { preview = true } = {}) {
    const asset = state.outputs[0];
    const directory = join(this.dataDir, 'results');
    await mkdir(directory, { recursive: true, mode: 0o700 });
    const file = join(directory, `${job.id}.flac`);
    let info;
    try { info = await verifyMusicAudio(file, job.expected); }
    catch (error) {
      if (error.code !== 'ENOENT') throw error;
      const temp = `${file}.${randomUUID()}.tmp`;
      try {
        const response = await this.response(`/view?${new URLSearchParams(asset)}`, { timeoutMs: 180_000 });
        await pipeline(Readable.fromWeb(response.body), createWriteStream(temp, { flags: 'wx', mode: 0o600 }));
        info = await verifyMusicAudio(temp, job.expected);
        await rename(temp, file);
      } finally { await rm(temp, { force: true }); }
    }
    await this.afterTransfer?.({ direction: 'download', asset, path: file, bytes: info.bytes, sha256: await fileDigest(file) });
    return musicResult(job, file, info, this.dataDir, preview);
  }

  async #cacheImageResult(job, asset, index) {
    const directory = join(this.dataDir, 'results');
    await mkdir(directory, { recursive: true, mode: 0o700 });
    const file = join(directory, `${job.id}-${index + 1}.png`);
    let bytes;
    try { bytes = await verifyPng(file, job.expected); }
    catch (error) {
      if (error.code !== 'ENOENT') throw error;
      const temp = `${file}.${randomUUID()}.tmp`;
      try {
        const response = await this.response(`/view?${new URLSearchParams(asset)}`, { timeoutMs: 180_000 });
        await pipeline(Readable.fromWeb(response.body), createWriteStream(temp, { flags: 'wx', mode: 0o600 }));
        bytes = await verifyPng(temp, job.expected);
        await rename(temp, file);
      } finally { await rm(temp, { force: true }); }
    }
    await this.afterTransfer?.({ direction: 'download', asset, path: file, bytes,
      sha256: await fileDigest(file) });
    return { path: file, bytes, mediaType: 'image/png' };
  }
}
