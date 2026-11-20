import { constants } from 'node:fs';
import { open } from 'node:fs/promises';
import { inspectionContent } from './inspection.mjs';
import { assetContent } from './asset-preview.mjs';

// A preview failure must never hide a successfully retrieved generation.
export async function resultContent(result, thumbnail, { inlineAudio, inlineMusicAudio = false } = {}) {
  if (result.media === 'music' && result.preview) return assetContent(result, { inlineAudio: inlineAudio ?? inlineMusicAudio });
  let extra = [];
  let previewWarning;
  try {
    if (result.images?.length) {
      const preview = await inspectionContent(await thumbnail({ jobId: result.jobId }));
      extra = preview.content.filter(item => item.type === 'image');
    } else if (result.mediaType === 'audio/wav' && inlineAudio === true) {
      const file = await open(result.path, constants.O_RDONLY | constants.O_NONBLOCK | (constants.O_NOFOLLOW ?? 0));
      try {
        const stat = await file.stat();
        if (!stat.isFile() || stat.size > 8 * 1024 * 1024) throw new Error('Audio exceeds the inline preview limit; play the returned local path.');
        const bytes = await file.readFile();
        if (bytes.length > 8 * 1024 * 1024) throw new Error('Audio exceeds the inline preview limit.');
        extra = [{ type: 'audio', mimeType: 'audio/wav', data: bytes.toString('base64') }];
      } finally { await file.close(); }
    }
  } catch (error) { previewWarning = error.message ?? String(error); }
  const report = { ...result, ...(previewWarning ? { previewWarning } : {}) };
  return { content: [{ type: 'text', text: JSON.stringify(report) }, ...extra], structuredContent: report };
}
