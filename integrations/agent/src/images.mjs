import { constants } from 'node:fs';
import { open } from 'node:fs/promises';
import { z } from 'zod/v4';
import { validateAsset } from '../resources/project-core/domain.js';

export const referenceCrop = z.strictObject({
  x: z.number().min(0).max(1),
  y: z.number().min(0).max(1),
  scale: z.number().min(0.1).max(1).optional(),
});

export const IMAGE_MODEL_PROFILE = {
  diffusion_model: {
    dir: 'diffusion_models', filenames: ['flux-2-klein-4b.safetensors', 'flux-2-klein-4b-fp8.safetensors'],
    socket: 'model', type: 'MODEL', loader: 'UNETLoader', input: 'unet_name', options: { weight_dtype: 'default' },
  },
  text_encoder: {
    dir: 'text_encoders', filenames: ['qwen_3_4b.safetensors'],
    socket: 'clip', type: 'CLIP', loader: 'CLIPLoader', input: 'clip_name', options: { type: 'flux2', device: 'default' },
  },
  vae_name: {
    dir: 'vae', filenames: ['flux2-vae.safetensors'],
    socket: 'vae', type: 'VAE', loader: 'VAELoader', input: 'vae_name',
  },
};

// Check the nodes used directly in submissions or within the Klein expansion.
export const IMAGE_NODE_INPUTS = {
  HappyLatentKleinImage: ['prompt', 'width', 'height', 'seed'],
  HappyLatentKleinReference: ['image', 'width', 'height', 'x', 'y', 'scale'],
  SaveImage: ['images', 'filename_prefix'], LoadImage: ['image'],
  UNETLoader: ['unet_name', 'weight_dtype'], CLIPLoader: ['clip_name', 'type', 'device'], VAELoader: ['vae_name'],
  CLIPTextEncode: ['clip', 'text'], ImageScaleToTotalPixels: ['image', 'upscale_method', 'megapixels', 'resolution_steps'],
  VAEEncode: ['pixels', 'vae'], ReferenceLatent: ['conditioning', 'latent'], BasicGuider: ['model', 'conditioning'],
  KSamplerSelect: ['sampler_name'], Flux2Scheduler: ['steps', 'width', 'height'],
  EmptyFlux2LatentImage: ['width', 'height', 'batch_size'], RandomNoise: ['noise_seed'],
  SamplerCustomAdvanced: ['noise', 'guider', 'sampler', 'sigmas', 'latent_image'], VAEDecode: ['samples', 'vae'],
};

export function imageRequest(input) {
  if (!input || typeof input !== 'object' || Array.isArray(input)) throw new Error('Image request must be an object.');
  if (Object.keys(input).some(key => !['prompt', 'width', 'height', 'seed', 'references'].includes(key))) {
    throw new Error('Unknown image request field.');
  }
  const { prompt, width, height, seed = 42, references = [] } = input;
  if (typeof prompt !== 'string' || !prompt.trim() || prompt.length > 16000) throw new Error('Image prompt must contain 1–16000 characters.');
  for (const [name, value] of Object.entries({ width, height })) {
    if (!Number.isInteger(value) || value < 256 || value > 2048 || value % 32 !== 0) {
      throw new Error(`Image ${name} in pixels must be a multiple of 32 between 256 and 2048.`);
    }
  }
  if (!Number.isSafeInteger(seed) || seed < 0) throw new Error('Image seed must be a nonnegative safe integer.');
  if (!Array.isArray(references) || references.length > 4) throw new Error('Supply up to four image references.');
  const assets = references.map(value => {
    const asset = validateAsset(value);
    if (!/\.(png|jpe?g|webp)$/i.test(asset.filename)) throw new Error('References must be PNG, JPEG or WebP images returned by import_asset.');
    return value.crop === undefined ? asset : { ...asset, crop: referenceCrop.parse(value.crop) };
  });
  return { prompt, width, height, seed, references: assets };
}

export function imageWorkflow(request, models, prefix, { linkedModels = false } = {}) {
  const { references, ...inputs } = request;
  const graph = {
    image: { class_type: 'HappyLatentKleinImage', inputs },
    save: { class_type: 'SaveImage', inputs: { images: ['image', 0], filename_prefix: prefix } },
  };
  if (linkedModels) {
    for (const [key, { socket, loader, input, options }] of Object.entries(IMAGE_MODEL_PROFILE)) {
      graph[socket] = { class_type: loader, inputs: { [input]: models[key], ...options } };
      inputs[socket] = [socket, 0];
    }
  } else Object.assign(inputs, models);
  const framing = {};
  references.forEach(({ subfolder, filename, crop }, index) => {
    const id = `reference_${index + 1}`;
    graph[id] = { class_type: 'LoadImage', inputs: { image: `${subfolder}/${filename} [input]` } };
    graph.image.inputs[id] = [id, 0];
    if (crop) framing[id] = { crop };
  });
  if (Object.keys(framing).length) graph.image.inputs.reference_framing = JSON.stringify(framing);
  return graph;
}

export function imageOutputs(history, job, folder) {
  const entries = history?.outputs?.[job.saveNode]?.images ?? [];
  const names = new Set();
  const outputs = [];
  for (const item of entries) {
    if (item?.type !== 'output' || item.subfolder?.replaceAll('\\', '/') !== folder ||
        typeof item.filename !== 'string' || !new RegExp(`^${job.id}_[0-9]+_\\.png$`).test(item.filename) ||
        names.has(item.filename)) continue;
    names.add(item.filename);
    outputs.push({ filename: item.filename, subfolder: folder, type: 'output' });
  }
  // Stored jobs from earlier versions can have more than one PNG.
  return outputs.length === (job.expected.count ?? 1) ? outputs : null;
}

// Check the container and requested dimensions before accepting a result from
// /view or the cache. This is validation of a PNG container, not image decoding.
export async function verifyPng(file, expected) {
  const handle = await open(file, constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0));
  try {
    const info = await handle.stat();
    const signature = Buffer.alloc(8);
    await handle.read(signature, 0, 8, 0);
    if (!info.isFile() || !signature.equals(Buffer.from('89504e470d0a1a0a', 'hex'))) throw new Error('The saved image is not a PNG.');
    let offset = 8, hasHeader = false, hasData = false, ended = false;
    const header = Buffer.alloc(8);
    while (offset + 12 <= info.size) {
      await handle.read(header, 0, 8, offset);
      const length = header.readUInt32BE(0), type = header.toString('ascii', 4, 8);
      if (length > info.size - offset - 12) break;
      if (!hasHeader) {
        if (type !== 'IHDR' || length !== 13) break;
        const dimensions = Buffer.alloc(8);
        await handle.read(dimensions, 0, 8, offset + 8);
        if (dimensions.readUInt32BE(0) !== expected.width || dimensions.readUInt32BE(4) !== expected.height) {
          throw new Error('The saved PNG dimensions do not match the requested image.');
        }
        hasHeader = true;
      } else if (type === 'IHDR') break;
      if (type === 'IDAT' && length > 0) hasData = true;
      offset += length + 12;
      if (type === 'IEND') { ended = length === 0; break; }
    }
    if (!hasHeader || !hasData || !ended || offset !== info.size) throw new Error('The saved image does not contain a complete PNG container.');
    return info.size;
  } finally { await handle.close(); }
}
