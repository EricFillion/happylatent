import { createHash } from 'node:crypto';
import { readFile } from 'node:fs/promises';

const UUID = '[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}';
const NAMES = new Map([
  ['input/happylatent', /^[a-f0-9]{32}\.(png|wav|mp4)$/],
  ['output/happylatent/agent', new RegExp(`^${UUID}_(?:[0-9]+_\\.(?:png|mp4)|[0-9]+\\.flac)$`)],
  ['output/happylatent/clips', /^[a-f0-9]{32}\.(mp4|json)$/],
  ['output/happylatent/runs', /^[a-f0-9]{64}\.json$/],
]);
export const cloudAssetKey = asset => `${asset.type}/${asset.subfolder}/${asset.filename}`;
export const cloudDataHash = value => createHash('sha256').update(JSON.stringify(value)).digest('hex');

export function checkedCloudAsset(value) {
  const asset = { type: value?.type, subfolder: value?.subfolder, filename: value?.filename };
  if (![asset.type, asset.subfolder, asset.filename].every(v => typeof v === 'string')
      || !NAMES.get(`${asset.type}/${asset.subfolder}`)?.test(asset.filename)) {
    throw new Error('The remote file is outside the Happy Latent media namespace.');
  }
  return asset;
}

export async function cloudDataScript(request) {
  const encoded = Buffer.from(JSON.stringify(request)).toString('base64');
  return `import base64, json\nREQUEST = json.loads(base64.b64decode('${encoded}'))\n`
    + await readFile(new URL('./cloud-data.py', import.meta.url), 'utf8');
}

export function cloudTransferMessage(manifest) {
  const target = `Runpod Pod ${manifest.podId}`;
  const retention = 'These files, prompts and generated results remain on cloud storage until you explicitly clean them up or delete that storage. Stopping the Pod does not erase them.';
  if (manifest.operation === 'upload') {
    const rows = manifest.files.map(file => `${file.name} — ${(file.bytes / 1e9).toFixed(3)} GB (${file.bytes.toLocaleString('en-US')} bytes)`).join('\n');
    return `Send these local files to ${target}?\n\n${rows}\n\nDestination: ${manifest.destination}\n\n${retention}`;
  }
  const content = manifest.content;
  const lines = content.scenes
    ? [`Project: ${content.title}`, `Shared prompt: ${content.globalPrompt ?? ''}`,
      ...content.scenes.map(scene => `${scene.name ?? scene.id}: ${scene.prompt ?? ''}`),
      `Media references and audio settings: ${JSON.stringify({ scenes: content.scenes.map(({ prompt, ...scene }) => scene), audioSegments: content.audioSegments ?? [], musicSegments: content.musicSegments ?? [] })}`]
    : manifest.media === 'music'
      ? [`Music description: ${content.prompt ?? ''}`, `Lyrics: ${content.lyrics ?? ''}`, `Music settings: ${JSON.stringify(content)}`]
      : [`Prompt: ${content.prompt ?? ''}`, `Reference images: ${JSON.stringify(content.references ?? [])}`];
  return `Send this ${manifest.media} generation request to ${target}?\n\n${lines.join('\n\n')}\n\nThis sends the displayed text, media references and generation settings (${manifest.payloadBytes.toLocaleString('en-US')} bytes).\n\n${retention}`;
}
