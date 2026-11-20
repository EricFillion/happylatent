import { lstat, mkdir, realpath } from 'node:fs/promises';
import { dirname, join, parse, resolve } from 'node:path';

// Resolve existing aliases before displaying the destination for approval.
export async function canonicalDestination(path) {
  let parent = resolve(path);
  const missing = [];
  for (;;) {
    try { return join(await realpath(parent), ...missing.reverse()); }
    catch (error) {
      if (error.code !== 'ENOENT') throw error;
      if (dirname(parent) === parent) throw error;
      missing.push(parent.slice(dirname(parent).length + (dirname(parent).endsWith('/') ? 0 : 1)));
      parent = dirname(parent);
    }
  }
}

export async function safeModelDirectory(path, { create = false } = {}) {
  if (path !== resolve(path)) throw new Error('Model destination must be an absolute normalized path.');
  const root = parse(path).root;
  let current = root;
  for (const part of path.slice(root.length).split('/').filter(Boolean)) {
    current = join(current, part);
    let stat;
    try { stat = await lstat(current); }
    catch (error) {
      if (error.code !== 'ENOENT') throw error;
      if (!create) continue;
      try { await mkdir(current, { mode: 0o700 }); } catch (mkdirError) { if (mkdirError.code !== 'EEXIST') throw mkdirError; }
      stat = await lstat(current);
    }
    if (stat && (!stat.isDirectory() || stat.isSymbolicLink())) throw new Error('Model destination contains a symlink or non-directory. Review a new destination before downloading.');
  }
}

export function trustedModelUrl(value) {
  const url = new URL(value);
  const host = url.hostname.toLowerCase();
  const allowed = host === 'huggingface.co' || host.endsWith('.huggingface.co') || host.endsWith('.hf.co');
  if (url.protocol !== 'https:' || url.username || url.password || (url.port && url.port !== '443') || !allowed) {
    throw new Error('Model download refused a destination outside the supported Hugging Face hosts.');
  }
  return url;
}
