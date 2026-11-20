import { assetPreview } from './asset-preview.mjs';
import { spawn } from 'node:child_process';
import { constants } from 'node:fs';
import { open } from 'node:fs/promises';
import { z } from 'zod/v4';

export const MUSIC_MODEL = 'ace-step-1.5-xl-turbo';

// Matches Comfy-Org/workflow_templates/templates/audio_ace_step1_5_xl_turbo.json.
// Keep XL explicit: a smaller ACE-Step checkpoint must never silently substitute.
export const MUSIC_MODEL_PROFILE = {
  model: {
    dir: 'diffusion_models', loader: 'UNETLoader', input: 'unet_name',
    filenames: ['acestep_v1.5_xl_turbo_bf16.safetensors'],
  },
  text_encoder: {
    dir: 'text_encoders', loader: 'DualCLIPLoader', input: 'clip_name1',
    filenames: ['qwen_0.6b_ace15.safetensors'],
  },
  planner: {
    dir: 'text_encoders', loader: 'DualCLIPLoader', input: 'clip_name2',
    filenames: ['qwen_4b_ace15.safetensors'],
  },
  vae: { dir: 'vae', loader: 'VAELoader', input: 'vae_name', filenames: ['ace_1.5_vae.safetensors'] },
};

export const MUSIC_NODE_INPUTS = {
  UNETLoader: ['unet_name', 'weight_dtype'],
  DualCLIPLoader: ['clip_name1', 'clip_name2', 'type', 'device'],
  VAELoader: ['vae_name'],
  'TextEncodeAceStepAudio1.5': ['clip', 'tags', 'lyrics', 'seed', 'bpm', 'duration',
    'timesignature', 'language', 'keyscale', 'generate_audio_codes', 'cfg_scale',
    'temperature', 'top_p', 'top_k', 'min_p'],
  'EmptyAceStep1.5LatentAudio': ['seconds', 'batch_size'],
  ModelSamplingAuraFlow: ['model', 'shift'],
  ConditioningZeroOut: ['conditioning'],
  KSampler: ['model', 'positive', 'negative', 'latent_image', 'seed', 'steps', 'cfg', 'sampler_name', 'scheduler', 'denoise'],
  VAEDecodeAudio: ['samples', 'vae'],
  SaveAudio: ['audio', 'filename_prefix'],
};

export const MUSIC_LANGUAGES = ['ar', 'az', 'bg', 'bn', 'ca', 'cs', 'da', 'de', 'el', 'en', 'es', 'fa', 'fi', 'fr', 'he', 'hi', 'hr', 'ht', 'hu', 'id', 'is', 'it', 'ja', 'ko', 'la', 'lt', 'ms', 'ne', 'nl', 'no', 'pa', 'pl', 'pt', 'ro', 'ru', 'sa', 'sk', 'sr', 'sv', 'sw', 'ta', 'te', 'th', 'tl', 'tr', 'uk', 'ur', 'vi', 'yue', 'zh', 'unknown'];
export const MUSIC_KEYS = ['major', 'minor'].flatMap(quality =>
  ['C', 'C#', 'Db', 'D', 'D#', 'Eb', 'E', 'F', 'F#', 'Gb', 'G', 'G#', 'Ab', 'A', 'A#', 'Bb', 'B'].map(root => `${root} ${quality}`));

export const musicRequestFields = {
  prompt: z.string().trim().min(1).max(16000).describe('Describe style, instruments, mood and musical development. Actual event timing must be measured after generation.'),
  durationSeconds: z.number().min(10).max(600).describe('Generate 10–600 seconds per track, rounded up to the model’s 40 ms grid so the source covers the requested time. Use a longer track and trim for shorter cues; do not silently loop to fill a longer video.'),
  lyrics: z.string().max(16000).default('').describe('Optional written lyrics; supplying lyrics defaults instrumental to false.'),
  instrumental: z.boolean().optional().describe('Defaults to true when lyrics are empty. For sung vocals provide lyrics and set false. Instrumental is a generation instruction, not verified vocal absence.'),
  bpm: z.number().int().min(10).max(300).default(120),
  keyscale: z.enum(MUSIC_KEYS).default('C major'),
  timesignature: z.enum(['2', '3', '4', '6']).default('4'),
  language: z.enum(MUSIC_LANGUAGES).default('en'),
  seed: z.number().int().nonnegative().max(Number.MAX_SAFE_INTEGER).default(42),
};
export const musicRequestSchema = z.strictObject(musicRequestFields);

export function musicRequest(input) {
  const request = musicRequestSchema.parse(input);
  request.lyrics = request.lyrics.trim();
  request.instrumental ??= !request.lyrics;
  if (request.instrumental && request.lyrics && request.lyrics !== '[Instrumental]') {
    throw new Error('Instrumental music cannot include sung lyrics. Remove lyrics or set instrumental to false.');
  }
  if (!request.instrumental && (!request.lyrics || request.lyrics === '[Instrumental]')) {
    throw new Error('Provide written lyrics for vocal music, or use instrumental music.');
  }
  if (request.instrumental) request.lyrics = '';
  return request;
}

export function musicGenerationDuration(durationSeconds) {
  if (!Number.isFinite(durationSeconds) || durationSeconds < 10 || durationSeconds > 600) {
    throw new Error('Music duration must be between 10 and 600 seconds.');
  }
  // ACE 1.5 decodes each latent position to 1,920 samples at 48 kHz (25 Hz).
  // Its native node rounds to the nearest position. Round up first so an exact
  // video-frame duration never produces a source a few milliseconds too short.
  // This generates genuine extra audio (at most 40 ms), without silence/loops.
  return Math.ceil(durationSeconds * 25) / 25;
}

export function musicWorkflow(input, models, prefix) {
  const request = musicRequest(input);
  const generatedDuration = musicGenerationDuration(request.durationSeconds);
  for (const [key, { filenames }] of Object.entries(MUSIC_MODEL_PROFILE)) {
    const name = models?.[key];
    if (typeof name !== 'string' || !filenames.includes(name.split(/[\\/]/).at(-1))) {
      throw new Error(`The ACE-Step 1.5 XL Turbo ${key} component is missing or incompatible.`);
    }
  }
  if (typeof prefix !== 'string' || !/^happylatent\/agent\/[0-9a-f-]{36}$/.test(prefix)) {
    throw new Error('Music output must use an owned Happy Latent job prefix.');
  }
  return {
    model: { class_type: 'UNETLoader', inputs: { unet_name: models.model, weight_dtype: 'default' } },
    clip: { class_type: 'DualCLIPLoader', inputs: { clip_name1: models.text_encoder,
      clip_name2: models.planner, type: 'ace', device: 'default' } },
    vae: { class_type: 'VAELoader', inputs: { vae_name: models.vae } },
    conditioning: { class_type: 'TextEncodeAceStepAudio1.5', inputs: {
      clip: ['clip', 0], tags: request.instrumental ? `${request.prompt}, instrumental, no vocals` : request.prompt,
      lyrics: request.instrumental ? '[Instrumental]' : request.lyrics,
      seed: request.seed, bpm: request.bpm, duration: generatedDuration,
      timesignature: request.timesignature, language: request.instrumental ? 'unknown' : request.language,
      keyscale: request.keyscale, generate_audio_codes: true,
      cfg_scale: 2, temperature: 0.85, top_p: 0.9, top_k: 0, min_p: 0,
    } },
    negative: { class_type: 'ConditioningZeroOut', inputs: { conditioning: ['conditioning', 0] } },
    latent: { class_type: 'EmptyAceStep1.5LatentAudio', inputs: { seconds: generatedDuration, batch_size: 1 } },
    sampling: { class_type: 'ModelSamplingAuraFlow', inputs: { model: ['model', 0], shift: 3 } },
    sampler: { class_type: 'KSampler', inputs: { model: ['sampling', 0], positive: ['conditioning', 0],
      negative: ['negative', 0], latent_image: ['latent', 0], seed: request.seed,
      steps: 8, cfg: 1, sampler_name: 'euler', scheduler: 'simple', denoise: 1 } },
    decode: { class_type: 'VAEDecodeAudio', inputs: { samples: ['sampler', 0], vae: ['vae', 0] } },
    save: { class_type: 'SaveAudio', inputs: { audio: ['decode', 0], filename_prefix: prefix } },
  };
}

export function musicOutputs(history, job, folder = 'happylatent/agent') {
  if (!/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/.test(job?.id ?? '')) return null;
  const entries = history?.outputs?.[job.saveNode]?.audio ?? [];
  if (!Array.isArray(entries)) return null;
  const names = new Set(), outputs = [];
  for (const item of entries) {
    if (item?.type !== 'output' || item.subfolder?.replaceAll('\\', '/') !== folder ||
        typeof item.filename !== 'string' || !new RegExp(`^${job.id}_[0-9]+\\.flac$`).test(item.filename) ||
        names.has(item.filename)) continue;
    names.add(item.filename);
    outputs.push({ filename: item.filename, subfolder: folder, type: 'output' });
  }
  return outputs.length === 1 ? outputs : null;
}

async function decodedPcmBytes(file, maximum) {
  return new Promise((resolve, reject) => {
    const child = spawn('ffmpeg', ['-hide_banner', '-nostdin', '-v', 'error', '-xerror',
      '-protocol_whitelist', 'file,pipe', '-f', 'flac', '-i', file, '-map', '0:a:0',
      '-vn', '-c:a', 'pcm_s16le', '-f', 's16le', 'pipe:1'], { windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'] });
    let bytes = 0, failure, stderrBytes = 0;
    const timeout = setTimeout(() => { failure = 'Music audio verification exceeded two minutes.'; child.kill('SIGKILL'); }, 120000);
    child.stdout.on('data', chunk => {
      bytes += chunk.length;
      if (bytes > maximum) { failure = 'The music file decodes beyond its declared sample count.'; child.kill('SIGKILL'); }
    });
    child.stderr.on('data', chunk => {
      stderrBytes += chunk.length;
      if (stderrBytes > 65536) { failure = 'The music decoder reported excessive errors.'; child.kill('SIGKILL'); }
    });
    child.on('error', error => {
      clearTimeout(timeout);
      reject(new Error(error.code === 'ENOENT' ? 'Music result verification requires FFmpeg on the MCP host PATH.' : 'Could not start music audio verification.'));
    });
    child.on('close', code => {
      clearTimeout(timeout);
      if (failure || code !== 0) reject(new Error(failure ?? 'The generated music file could not be decoded completely.'));
      else resolve(bytes);
    });
  });
}

// FLAC STREAMINFO declares the exact sample count. Decode and count PCM bytes
// as well, so a truncated file with an otherwise valid header is never cached.
export async function verifyMusicAudio(file, expected = {}) {
  const handle = await open(file, constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0));
  let info;
  try {
    const stat = await handle.stat();
    if (!stat.isFile() || stat.size < 43 || stat.size > 512 * 1024 * 1024) throw new Error('Music result must be a nonempty regular FLAC file below 512 MB.');
    const header = Buffer.alloc(42);
    const { bytesRead } = await handle.read(header, 0, 42, 0);
    if (bytesRead !== 42 || header.toString('ascii', 0, 4) !== 'fLaC' ||
        (header[4] & 127) !== 0 || header.readUIntBE(5, 3) !== 34) throw new Error('Music result does not contain a valid FLAC STREAMINFO header.');
    const packed = header.readBigUInt64BE(18);
    const sampleRate = Number(packed >> 44n), channels = Number((packed >> 41n) & 7n) + 1;
    const sampleCount = Number(packed & 0xfffffffffn), durationSeconds = sampleCount / sampleRate;
    if (sampleRate !== 48000 || channels !== 2 || !Number.isFinite(durationSeconds) || durationSeconds < 0.1 || durationSeconds > 610) {
      throw new Error('ACE-Step music must contain stereo 48 kHz audio with a valid bounded duration.');
    }
    if (expected.durationSeconds !== undefined && (!Number.isFinite(expected.durationSeconds) ||
        Math.abs(durationSeconds - expected.durationSeconds) > Math.max(0.25, expected.durationSeconds * 0.01))) {
      throw new Error('The generated music duration does not match the requested track.');
    }
    let offset = 4, last = false;
    while (!last) {
      const block = Buffer.alloc(4);
      const read = await handle.read(block, 0, 4, offset);
      if (read.bytesRead !== 4) throw new Error('The generated FLAC metadata is incomplete.');
      last = Boolean(block[0] & 128);
      offset += 4 + block.readUIntBE(1, 3);
      if (offset >= stat.size || offset > 64 * 1024 * 1024) throw new Error('The generated FLAC metadata is incomplete or oversized.');
    }
    info = { bytes: stat.size, sampleRate, channels, sampleCount, durationSeconds, duration: durationSeconds, mediaType: 'audio/flac' };
  } finally { await handle.close(); }
  const expectedBytes = info.sampleCount * info.channels * 2;
  if (await decodedPcmBytes(file, expectedBytes) !== expectedBytes) throw new Error('The generated music file is truncated or has an incorrect sample count.');
  return info;
}

export async function musicResult(job, file, info, stateDir, preview = true) {
  return { jobId: job.id, media: 'music', model: 'ACE-Step 1.5 XL Turbo', path: file, mediaType: 'audio/flac', ...info,
    settings: job.transferContent, ...(preview ? { preview: await assetPreview({ kind: 'audio', file, sourcePath: file, stateDir }) } : {}),
    nextStep: 'Use analyze_music with jobId to measure the recording. Use import_generated_music, then plan_music/place_music to add it as a separate soundtrack without replacing dialogue.' };
}
