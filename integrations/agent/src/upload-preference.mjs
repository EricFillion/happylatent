import { mkdir, readFile, writeFile, rename } from 'node:fs/promises';
import { join } from 'node:path';
import { randomUUID } from 'node:crypto';

const modes = ['allow_all', 'ask_each_time'];
const requestedSchema = {
  type: 'object',
  properties: { mode: { type: 'string', title: 'Runpod uploads',
    enum: modes, enumNames: ['Allow all — don’t ask again', 'Allow this transfer — keep asking'] } },
  required: ['mode'],
};

// Only a client elicitation response can grant standing upload consent.
export class UploadPreference {
  constructor(stateDir, request) {
    this.directory = stateDir; this.path = join(stateDir, 'cloud-upload-preference.json');
    this.request = request; this.tail = Promise.resolve();
  }
  serial(work) {
    const pending = this.tail.then(work);
    this.tail = pending.catch(() => {});
    return pending;
  }
  async read() {
    try {
      const saved = JSON.parse(await readFile(this.path, 'utf8'));
      return { mode: modes.includes(saved.mode) ? saved.mode : 'not_set' };
    } catch (error) {
      if (error.code === 'ENOENT' || error instanceof SyntaxError) return { mode: 'not_set' };
      throw error;
    }
  }
  async choose(message, signal) {
    const schema = message ? requestedSchema : { ...requestedSchema, properties: { mode: {
      ...requestedSchema.properties.mode, enumNames: [
        'Allow all — don’t ask again', 'Ask before each transfer',
      ],
    } } };
    const response = await this.request({ signal, requestedSchema: schema, message: [
      message ? 'Allow this Runpod transfer?' : 'How should Happy Latent handle Runpod uploads?',
      'Allow all: remember permission on this installation to send media files and generation prompts needed for your requests to current and future connected Runpod Pods. You will not be asked again for each transfer.',
      message
        ? 'Allow this transfer — keep asking: send only the transfer below now. Every later reminder also offers Allow all — don’t ask again.'
        : 'Ask before each transfer: keep reminders on. Each reminder lets you allow that transfer or choose Allow all — don’t ask again.',
      'This does not authorize new spending, model downloads or cleanup. Cloud data stays on the Pod until cleaned up. Change this choice anytime with configure_cloud_uploads.',
      ...(message ? ['', 'Accepting either choice also approves this transfer:', message] : []),
    ].join('\n\n') });
    if (signal?.aborted || response?.action !== 'accept' || !modes.includes(response.content?.mode)) {
      throw new Error('Upload preference was not confirmed. No data was sent and your preference was not changed.');
    }
    await mkdir(this.directory, { recursive: true, mode: 0o700 });
    const temporary = `${this.path}.${randomUUID()}.tmp`;
    await writeFile(temporary, JSON.stringify({ mode: response.content.mode }) + '\n', { flag: 'wx', mode: 0o600 });
    await rename(temporary, this.path);
    return { mode: response.content.mode };
  }
  configure(signal) { return this.serial(() => this.choose(undefined, signal)); }
  confirm(_manifest, message, signal) {
    return this.serial(async () => {
      if (signal?.aborted) throw new Error('Upload request was cancelled.');
      const { mode } = await this.read();
      if (mode !== 'allow_all') await this.choose(message, signal);
      return true;
    });
  }
}
