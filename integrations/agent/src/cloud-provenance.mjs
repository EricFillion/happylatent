import { createHash } from 'node:crypto';
import { lstat, readFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';

/** Template tags can move. A deployment always names immutable image content. */
export function validatePinnedTemplateImage(image) {
  if (typeof image !== 'string' || !/^runpod\/pytorch@sha256:[a-f0-9]{64}$/.test(image)) {
    throw new Error('Use the selected official Runpod PyTorch image resolved to runpod/pytorch@sha256:<digest>. Mutable image tags are not accepted.');
  }
  return image;
}

/** Release-owned locks; never resolve fresh Python dependencies on the Pod. */
export async function runtimeDependencyLock(platform = 'cloud') {
  const filenames = { cloud: 'runtime-requirements.txt', macos: 'runtime-requirements-macos.txt' };
  const filename = filenames[platform];
  if (!filename) throw new Error('Unsupported dependency-lock platform.');
  const root = new URL('./cloud-runtime/', import.meta.url);
  const metadata = JSON.parse(await readFile(new URL('dependency-lock.json', root), 'utf8'));
  const path = fileURLToPath(new URL(filename, root));
  const info = await lstat(path);
  if (!info.isFile() || info.isSymbolicLink() || info.size > 1024 * 1024) throw new Error('Unsafe runtime dependency lock.');
  const bytes = await readFile(path);
  const sha256 = createHash('sha256').update(bytes).digest('hex');
  if (metadata.version !== 1 || metadata.python !== '3.12' || metadata.locks?.[filename] !== sha256
      || !/^[a-f0-9]{40}$/.test(metadata.comfyRevision) || !/^[a-f0-9]{64}$/.test(metadata.requirementsSha256)) {
    throw new Error('Runtime dependency lock failed integrity verification.');
  }
  return { path, filename, bytes, sha256, metadata };
}
