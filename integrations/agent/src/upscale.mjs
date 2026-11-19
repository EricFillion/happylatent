export const upscaleNodes = {
  HappyLatentLoadUpscaleSource: ['clip_id'],
  VAELoader: ['vae_name'],
  UNETLoader: ['unet_name'],
  CLIPLoader: ['clip_name'],
  LatentUpscaleModelLoader: ['model_name'],
  VAEEncodeTiled: ['pixels', 'vae'],
  LTXVLatentUpsampler: ['samples', 'vae', 'upscale_model'],
  CLIPTextEncode: ['text', 'clip'],
  ConditioningZeroOut: ['conditioning'],
  LTXVConditioning: ['positive', 'negative', 'frame_rate'],
  LTXVAddGuide: ['positive', 'negative', 'latent', 'image', 'vae', 'frame_idx', 'strength'],
  LTXVCropGuides: ['positive', 'negative', 'latent'],
  ImageFromBatch: ['image', 'batch_index', 'length'],
  LTXVDualCFGGuider: ['model', 'positive', 'negative', 'video_cfg', 'audio_cfg'],
  RandomNoise: ['noise_seed'],
  KSamplerSelect: ['sampler_name'],
  ManualSigmas: ['sigmas'],
  SamplerCustomAdvanced: ['noise', 'guider', 'sampler', 'sigmas', 'latent_image'],
  HappyLatentDecode: ['samples', 'vae'],
  HappyLatentTrimFrames: ['images', 'frames'],
  HappyLatentSaveTake: ['images', 'audio', 'fps', 'record'],
  HappyLatentPublishRun: ['video', 'run'],
  SaveVideo: ['video', 'filename_prefix'],
};

export function upscaleSource(clip) {
  const { frameCount, fps, width, height } = clip;
  if (!Number.isInteger(fps) || frameCount > fps * 20) throw new Error('Upscaling needs a take up to 20 seconds at a whole-number FPS.');
  if ([width, height].some(size => size < 64 || size > 2048 || size % 32)) {
    throw new Error('Upscaling needs source dimensions of 64–2048 pixels in multiples of 32.');
  }
  const padded = Math.max(9, Math.ceil((frameCount - 1) / 8) * 8 + 1);
  if (padded * width * height > 96_000_000) throw new Error('This take exceeds the upscale frame budget. Import a shorter excerpt first.');
  return { frames: frameCount, fps, width: width * 2, height: height * 2 };
}

export function upscaleWorkflow(source, models, { runId, projectId, prefix, prompt }) {
  const expected = upscaleSource(source);
  const graph = {};
  const node = (id, class_type, inputs) => {
    graph[id] = { class_type, inputs };
    return [id, 0];
  };
  const vae = node('vae', 'VAELoader', { vae_name: models.video_vae });
  const model = node('model', 'UNETLoader', { unet_name: models.model, weight_dtype: 'default' });
  const clip = node('text_model', 'CLIPLoader', { clip_name: models.clip, type: 'ltxv', device: 'default' });
  const pixels = node('source', 'HappyLatentLoadUpscaleSource', { clip_id: source.id });
  const encoded = node('encoded_source', 'VAEEncodeTiled', { pixels, vae, tile_size: 512,
    overlap: 64, temporal_size: 64, temporal_overlap: 16 });
  const upscaleModel = node('upscaler', 'LatentUpscaleModelLoader', { model_name: models.spatialUpscale });
  let latent = node('upscale', 'LTXVLatentUpsampler', { samples: encoded, upscale_model: upscaleModel, vae });
  const text = node('text', 'CLIPTextEncode', { clip, text: prompt });
  const empty = node('negative', 'ConditioningZeroOut', { conditioning: text });
  let positive = node('conditioning', 'LTXVConditioning', { positive: text, negative: empty, frame_rate: expected.fps });
  let negative = ['conditioning', 1];

  // Anchor the refinement to decoded source frames, including both endpoints.
  const stride = Math.max(8, expected.fps);
  const frames = new Set([0]);
  for (let index = stride; index < expected.frames - 1; index += stride) frames.add(index);
  frames.add(expected.frames - 1);
  for (const frame of frames) {
    const image = node(`source_frame_${frame}`, 'ImageFromBatch', { image: pixels, batch_index: frame, length: 1 });
    positive = node(`guide_${frame}`, 'LTXVAddGuide', { positive, negative, latent, vae, image, frame_idx: frame, strength: 1 });
    negative = [positive[0], 1];
    latent = [positive[0], 2];
  }
  const guider = node('guider', 'LTXVDualCFGGuider', { model, positive, negative, video_cfg: 1, audio_cfg: 1 });
  const noise = node('noise', 'RandomNoise', { noise_seed: 0 });
  const sampler = node('sampler', 'KSamplerSelect', { sampler_name: 'euler_ancestral' });
  const sigmas = node('sigmas', 'ManualSigmas', { sigmas: '0.421875, 0.0' });
  const refined = node('upscale_refine', 'SamplerCustomAdvanced', { noise, guider, sampler, sigmas, latent_image: latent });
  const cropped = node('remove_guides', 'LTXVCropGuides', { positive, negative, latent: refined });
  const decoded = node('decode', 'HappyLatentDecode', { samples: [cropped[0], 2], vae });
  const images = node('trim', 'HappyLatentTrimFrames', { images: decoded, frames: expected.frames });

  const id = runId.replaceAll('-', '');
  const take = { id, asset: { filename: `${id}.mp4`, subfolder: 'happylatent/clips', type: 'output' },
    frameCount: expected.frames, fps: expected.fps, width: expected.width, height: expected.height, hasAudio: source.hasAudio,
    name: `${source.name || 'Clip'} · AI upscale`.slice(0, 120), projectId,
    ...(source.sceneId ? { sceneId: source.sceneId } : {}) };
  const recipe = { operation: 'upscale', sourceClipId: source.id, models, prompt, spatialScale: 2, refine: true };
  const video = node('take', 'HappyLatentSaveTake', { images, audio: ['source', 1], fps: take.fps,
    record: JSON.stringify({ clip: take, recipe, runId, scope: 'selection' }) });
  const published = node('publish', 'HappyLatentPublishRun', { video,
    run: JSON.stringify({ runId, projectId, scope: 'selection', clips: [{ ...take, sceneId: source.sceneId ?? '' }], complete: true }) });
  node('save', 'SaveVideo', { video: published, filename_prefix: prefix, format: 'mp4', 'format.codec': 'auto' });
  return graph;
}
