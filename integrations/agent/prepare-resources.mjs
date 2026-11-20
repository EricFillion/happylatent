import { copyFile, cp, lstat, mkdir, rename, rm } from 'node:fs/promises';
import { randomUUID } from 'node:crypto';
import { basename } from 'node:path';

const from = new URL('../../', import.meta.url);
const into = new URL('./resources/', import.meta.url);
await mkdir(new URL('project-core/', into), { recursive: true });
for (const [source, destination] of [
  ['web/domain.js', 'project-core/domain.js'],
  ['web/audio.js', 'project-core/audio.js'],
  ['workflows/mcp/happylatent.json', 'happylatent.json'],
  ['workflows/mcp/happylatent-api.json', 'happylatent-api.json'],
]) {
  // MCP processes can import these modules while a bundle is being prepared.
  const temporary = new URL(`${destination}.${randomUUID()}.tmp`, into);
  try {
    await copyFile(new URL(source, from), temporary);
    await rename(temporary, new URL(destination, into));
  } finally {
    await rm(temporary, { force: true });
  }
}

// The cloud upload-bundle tool must also work from the installed MCP bundle.
// Include only the node's public source/assets, never the development workspace.
const node = new URL('node/', into);
await rm(node, { recursive: true, force: true });
await mkdir(node, { recursive: true });
for (const name of ['__init__.py', 'happylatent', 'extension', 'web', 'workflows/mcp',
  'pyproject.toml', 'README.md', 'LICENSE']) {
  await cp(new URL(name, from), new URL(name, node), { recursive: true, filter: async path => {
    const name = basename(path);
    if (name.startsWith('.') || name === '__pycache__' || name.endsWith('.pyc')) return false;
    if ((await lstat(path)).isSymbolicLink()) throw new Error('Node bundle source cannot contain symlinks.');
    return true;
  } });
}
