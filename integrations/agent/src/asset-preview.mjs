import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { mkdir, mkdtemp, readFile, rm, stat } from 'node:fs/promises';
import { join, basename } from 'node:path';

const exec = promisify(execFile);
const EXCERPT_SECONDS = 30;
const MAX_INLINE = 8 * 1024 * 1024;
async function run(binary, args) {
  try {
    return await exec(binary, args, { timeout: 30_000, maxBuffer: 1024 * 1024, windowsHide: true });
  } catch (error) {
    throw new Error(error.code === 'ENOENT'
      ? 'Install local ffmpeg and ffprobe for rich upload previews. The upload succeeded; use the local source path.'
      : 'Could not preview this media within the processing limit. The upload succeeded; use the local source path.');
  }
}
const input = path => ['-protocol_whitelist', 'file,pipe', '-i', path];
const ffmpeg = args => run('ffmpeg', ['-hide_banner', '-nostdin', '-v', 'error', '-y', ...args]);
const number = value => Number.isFinite(Number(value)) ? Number(value) : undefined;

// Called with the frozen upload bytes, before their temporary snapshot is removed.
// Derived previews stay local and do not cause another cloud transfer.
export async function assetPreview({ kind, file, sourcePath, stateDir }) {
  const preview = { kind, sourcePath, name: basename(sourcePath) };
  let directory;
  try {
    const { stdout } = await run('ffprobe', ['-v', 'error', ...input(file), '-show_streams', '-show_format', '-of', 'json']);
    const probe = JSON.parse(stdout);
    const video = probe.streams?.find(stream => stream.codec_type === 'video');
    const audio = probe.streams?.find(stream => stream.codec_type === 'audio');
    if (kind !== 'image') {
      preview.durationSeconds = number(probe.format?.duration);
      if (!(preview.durationSeconds > 0)) throw new Error('Preview duration is unavailable. Use the local source path.');
    }
    if (kind !== 'audio') {
      if (!video || !(video.width > 0 && video.height > 0) || video.width * video.height > 8192 * 8192) {
        throw new Error('Media dimensions exceed the preview limit. Use the local source path.');
      }
      preview.width = video.width; preview.height = video.height;
    }
    const root = join(stateDir, 'upload-previews');
    await mkdir(root, { recursive: true, mode: 0o700 });
    directory = await mkdtemp(join(root, 'asset-'));
    if (kind === 'image') {
      preview.imagePath = join(directory, 'image.png');
      await ffmpeg([...input(file), '-map', '0:v:0', '-frames:v', '1', '-vf',
        "scale='min(1024,iw)':'min(1024,ih)':force_original_aspect_ratio=decrease", preview.imagePath]);
    } else if (kind === 'audio') {
      if (!audio) throw new Error('No audio stream to preview. Use the local source path.');
      preview.sampleRate = number(audio.sample_rate); preview.channels = audio.channels;
      preview.excerptSeconds = Math.min(EXCERPT_SECONDS, preview.durationSeconds);
      preview.truncated = preview.durationSeconds > EXCERPT_SECONDS;
      preview.audioPath = join(directory, 'excerpt.wav');
      await ffmpeg([...input(file), '-map', '0:a:0', '-t', String(EXCERPT_SECONDS), '-ac', '1', '-ar', '24000', '-c:a', 'pcm_s16le', preview.audioPath]);
      preview.imagePath = join(directory, 'waveform.png');
      await ffmpeg([...input(preview.audioPath), '-filter_complex',
        '[0:a:0]showwavespic=s=1024x200:colors=0x59b8ff[v]', '-map', '[v]', '-frames:v', '1', preview.imagePath]);
      preview.note = 'Playback and waveform cover the first 30 seconds at most. Use sourcePath for the full original audio.';
    } else if (kind === 'video') {
      preview.hasAudio = !!audio;
      const [a, b = 1] = String(video.avg_frame_rate).split('/').map(Number);
      preview.fps = Number.isFinite(a / b) ? a / b : undefined;
      // Interior samples avoid seeking past the last decodable frame.
      preview.timestamps = [0, 0.5, 0.9].map(fraction => fraction * preview.durationSeconds);
      for (const [index, timestamp] of preview.timestamps.entries()) {
        await ffmpeg(['-ss', String(timestamp), ...input(file), '-map', '0:v:0', '-frames:v', '1', '-vf',
          'scale=320:180:force_original_aspect_ratio=decrease,pad=320:180:(ow-iw)/2:(oh-ih)/2', join(directory, `frame-${index}.png`)]);
      }
      preview.imagePath = join(directory, 'contact-sheet.png');
      await ffmpeg(['-framerate', '1', '-i', join(directory, 'frame-%d.png'), '-vf',
        'tile=3x1:nb_frames=3:padding=4:margin=4:color=black', '-frames:v', '1', preview.imagePath]);
      preview.note = 'Contact sheet reads left to right at the listed timestamps. Use sourcePath for full video playback; still frames do not assess motion or audio.';
    }
    for (const path of [preview.imagePath, preview.audioPath].filter(Boolean)) {
      if ((await stat(path)).size > MAX_INLINE) throw new Error('Preview exceeds the inline size limit. Use the local source path.');
    }
    return preview;
  } catch (error) {
    if (directory) await rm(directory, { recursive: true, force: true }).catch(() => {});
    return { kind, sourcePath, name: preview.name, warning: error.message ?? String(error) };
  }
}

export async function assetContent(result, { inlineAudio = false } = {}) {
  const content = [];
  let previewWarning;
  try {
    for (const [path, type, mimeType] of [
      [result.preview?.imagePath, 'image', 'image/png'],
      [result.preview?.audioPath, 'audio', 'audio/wav'],
    ]) {
      if (!path || (type === 'audio' && !inlineAudio)) continue;
      if ((await stat(path)).size > MAX_INLINE) throw new Error('Preview exceeds the inline size limit.');
      const bytes = await readFile(path);
      if (bytes.length > MAX_INLINE) throw new Error('Preview exceeds the inline size limit.');
      content.push({ type, mimeType, data: bytes.toString('base64') });
    }
  } catch (error) { previewWarning = error.message ?? String(error); }
  const report = { ...result, ...(previewWarning ? { previewWarning } : {}) };
  return { content: [{ type: 'text', text: JSON.stringify(report) }, ...content], structuredContent: report };
}
