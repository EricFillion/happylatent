import { mkdir, readFile, writeFile, rename } from 'node:fs/promises';
import { join } from 'node:path';
import { randomUUID } from 'node:crypto';
const modes = new Set(['ask', 'keep_running', 'stop_after_results']);
export class ShutdownPreference {
  constructor(stateDir) { this.directory = stateDir; this.path = join(stateDir, 'cloud-shutdown-preference.json'); }
  async read() {
    try {
      const saved = JSON.parse(await readFile(this.path, 'utf8'));
      return { mode: modes.has(saved.mode) ? saved.mode : 'ask' };
    } catch (error) {
      if (error.code === 'ENOENT' || error instanceof SyntaxError) return { mode: 'ask' };
      throw error;
    }
  }
  async set(mode) {
    if (!modes.has(mode)) throw new Error('Unknown cloud shutdown preference.');
    await mkdir(this.directory, { recursive: true, mode: 0o700 });
    const temporary = `${this.path}.${randomUUID()}.tmp`;
    await writeFile(temporary, JSON.stringify({ mode }) + '\n', { flag: 'wx', mode: 0o600 });
    await rename(temporary, this.path);
    return { mode };
  }
}
