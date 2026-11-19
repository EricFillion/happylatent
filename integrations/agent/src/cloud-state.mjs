import { randomUUID } from 'node:crypto';
import { link, readFile, rename, rm, writeFile } from 'node:fs/promises';
import { join } from 'node:path';

export function cloudSelectionPath({ stateDir, runtimeProfile }) {
  return join(stateDir, 'cloud', runtimeProfile ? `active-${runtimeProfile}.json` : 'active.json');
}

export async function readOptional(path) {
  try { return JSON.parse(await readFile(path, 'utf8')); }
  catch (error) { if (error.code === 'ENOENT') return undefined; throw error; }
}

export async function save(path, value, { exclusive = false } = {}) {
  const temp = `${path}.${randomUUID()}.tmp`;
  try {
    await writeFile(temp, JSON.stringify(value, null, 2) + '\n', { flag: 'wx', mode: 0o600 });
    if (exclusive) {
      try { await link(temp, path); } catch (error) { if (error.code === 'EEXIST') return false; throw error; }
    } else await rename(temp, path);
    return true;
  } finally { await rm(temp, { force: true }); }
}
