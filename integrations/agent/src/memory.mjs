import { constants } from 'node:fs';
import { createHash, randomUUID } from 'node:crypto';
import { link, lstat, mkdir, open, readdir, realpath, unlink, writeFile } from 'node:fs/promises';
import { isAbsolute, join, relative, resolve, sep } from 'node:path';
import { z } from 'zod/v4';

const uuid = z.string().regex(/^[a-f0-9]{8}(?:-[a-f0-9]{4}){3}-[a-f0-9]{12}$/);
const revision = z.number().int().positive().max(Number.MAX_SAFE_INTEGER);
const text = (max) => z.string().trim().max(max);
const voice = z.strictObject({
  speaker: z.string().trim().regex(/^[abefhip][fm]_[a-z0-9_]{1,29}$/),
  speed: z.number().finite().min(0.5).max(2).default(1),
});
export const memoryFields = {
  kind: z.enum(['character', 'location']),
  name: text(120).min(1),
  description: text(8000).min(1),
  notes: text(8000).optional(),
  tags: z.array(text(60).min(1)).max(20).optional(),
  voice: voice.optional(),
  referencePaths: z.array(z.string().min(1).max(4096)).max(4).optional(),
};
export const memorySelector = z.strictObject({ memoryId: uuid, revision: revision.optional() });
const saveSchema = z.strictObject({ ...memoryFields, memoryId: uuid.optional(), expectedRevision: revision.optional() });
const archiveSchema = z.strictObject({ memoryId: uuid, expectedRevision: revision, archived: z.boolean() });
const listSchema = z.strictObject({ includeArchived: z.boolean().default(false), kind: memoryFields.kind.optional(), query: text(500).optional(), limit: z.number().int().min(1).max(100).default(20), offset: z.number().int().nonnegative().max(Number.MAX_SAFE_INTEGER).default(0) });
const refSchema = z.strictObject({ path: z.string().min(1).max(4096), sha256: z.string().regex(/^[a-f0-9]{64}$/) });
export const memoryEntry = z.strictObject({
  memoryId: uuid, revision, kind: memoryFields.kind, name: memoryFields.name, description: memoryFields.description,
  notes: text(8000), tags: z.array(text(60).min(1)).max(20), voice: voice.optional(),
  references: z.array(refSchema).max(4), archived: z.boolean(), createdAt: z.iso.datetime(), updatedAt: z.iso.datetime(),
});
const REVISION = /^[1-9][0-9]*\.json$/;
const ASSET = /^([a-f0-9]{64})\.(png|jpg|webp)$/;
const MAX_IMAGE = 20 * 1024 * 1024;
const contained = (root, path) => { const rel = relative(root, path); return !!rel && !isAbsolute(rel) && rel !== '..' && !rel.startsWith(`..${sep}`); };
function imageExtension(bytes) {
  if (bytes.length >= 24 && bytes.subarray(0, 8).equals(Buffer.from('89504e470d0a1a0a', 'hex')) && bytes.toString('ascii', 12, 16) === 'IHDR') return 'png';
  if (bytes.length >= 4 && bytes[0] === 0xff && bytes[1] === 0xd8 && bytes[2] === 0xff && bytes.at(-2) === 0xff && bytes.at(-1) === 0xd9) return 'jpg';
  if (bytes.length >= 16 && bytes.toString('ascii', 0, 4) === 'RIFF' && bytes.toString('ascii', 8, 12) === 'WEBP' && bytes.readUInt32LE(4) + 8 === bytes.length) return 'webp';
  throw new Error('Reference images must be PNG, JPEG or WebP files.');
}

/** Local creative memory shared by chats using the same state directory. Never starts a renderer. */
export class Memory {
  constructor({ stateDir, workspaceDir }) {
    this.stateDir = resolve(stateDir);
    this.workspaceDir = resolve(workspaceDir ?? join(this.stateDir, 'workspace'));
    this.root = join(this.stateDir, 'memories');
    this.assets = join(this.stateDir, 'memory-assets');
  }

  async owned(path, kind = 'file') {
    const stat = await lstat(path);
    if (stat.isSymbolicLink() || !(kind === 'directory' ? stat.isDirectory() : stat.isFile())) throw new Error('Memory storage must use regular owned files and directories.');
    const [root, target] = await Promise.all([realpath(this.stateDir), realpath(path)]);
    if (!contained(root, target)) throw new Error('Memory storage is outside the state directory.');
    return target;
  }

  async directory(path) {
    await mkdir(path, { recursive: true, mode: 0o700 });
    return this.owned(path, 'directory');
  }

  async bytes(path, max) {
    const handle = await open(path, constants.O_RDONLY | constants.O_NONBLOCK | (constants.O_NOFOLLOW ?? 0));
    try {
      const stat = await handle.stat();
      if (!stat.isFile() || !stat.size || stat.size > max) throw new Error('Invalid or oversized memory file.');
      const bytes = Buffer.alloc(stat.size);
      let offset = 0;
      while (offset < bytes.length) {
        const read = await handle.read(bytes, offset, bytes.length - offset, offset);
        if (!read.bytesRead) throw new Error('Memory file changed while reading.');
        offset += read.bytesRead;
      }
      const after = await handle.stat();
      if (after.size !== stat.size || after.mtimeMs !== stat.mtimeMs) throw new Error('Memory file changed while reading.');
      return bytes;
    } finally { await handle.close(); }
  }

  async latest(memoryId) {
    uuid.parse(memoryId);
    let names;
    try { names = await readdir(await this.owned(join(this.root, memoryId), 'directory')); }
    catch (error) { if (error.code === 'ENOENT') throw new Error('Memory was not found.'); throw error; }
    const latest = names.reduce((value, name) => REVISION.test(name) && Number.isSafeInteger(Number(name.slice(0, -5))) ? Math.max(value, Number(name.slice(0, -5))) : value, 0);
    if (!latest) throw new Error('Memory was not found.');
    return latest;
  }

  async get(input) {
    const { memoryId, revision: requested } = memorySelector.parse(input);
    const selected = requested ?? await this.latest(memoryId);
    let entry;
    try {
      const path = await this.owned(join(this.root, memoryId, `${selected}.json`));
      entry = memoryEntry.parse(JSON.parse((await this.bytes(path, 256 * 1024)).toString('utf8')));
    } catch (error) { if (error.code === 'ENOENT') throw new Error('Memory revision was not found.'); throw error; }
    if (entry.memoryId !== memoryId || entry.revision !== selected) throw new Error('Stored memory identifiers do not match.');
    if (entry.kind === 'location' && entry.voice) throw new Error('Locations cannot have a voice.');
    for (const reference of entry.references) this.referencePath(reference);
    return entry;
  }

  referencePath(reference) {
    const name = relative(this.assets, reference.path);
    if (!ASSET.test(name) || name.split('.')[0] !== reference.sha256) throw new Error('Invalid owned memory reference.');
    return join(this.assets, name);
  }

  async publish(entry) {
    memoryEntry.parse(entry);
    await this.directory(this.root);
    const directory = await this.directory(join(this.root, entry.memoryId));
    const temporary = join(directory, `.${randomUUID()}.tmp`);
    try {
      await writeFile(temporary, JSON.stringify(entry) + '\n', { flag: 'wx', mode: 0o600, flush: true });
      await link(temporary, join(directory, `${entry.revision}.json`));
    } catch (error) {
      if (error.code === 'EEXIST') throw new Error('Another chat changed this memory. Read the latest revision before retrying.');
      throw error;
    } finally { await unlink(temporary).catch(error => { if (error.code !== 'ENOENT') throw error; }); }
    return entry;
  }

  async retain(path) {
    const source = await realpath(resolve(this.workspaceDir, path));
    let allowed = false;
    try { allowed = contained(await realpath(this.workspaceDir), source); } catch (error) { if (error.code !== 'ENOENT') throw error; }
    if (!allowed) {
      try {
        const results = await this.owned(join(this.stateDir, 'results'), 'directory');
        allowed = /^[a-f0-9]{8}(?:-[a-f0-9]{4}){3}-[a-f0-9]{12}-[1-4]\.png$/.test(relative(results, source));
      } catch (error) { if (error.code !== 'ENOENT') throw error; }
    }
    if (!allowed) throw new Error('Choose a reference image inside the configured workspace or an owned cached image result.');
    const bytes = await this.bytes(source, MAX_IMAGE);
    const extension = imageExtension(bytes), sha256 = createHash('sha256').update(bytes).digest('hex');
    await this.directory(this.assets);
    const destination = join(this.assets, `${sha256}.${extension}`);
    const temporary = join(this.assets, `.${randomUUID()}.tmp`);
    try {
      await writeFile(temporary, bytes, { flag: 'wx', mode: 0o600, flush: true });
      try { await link(temporary, destination); }
      catch (error) {
        if (error.code !== 'EEXIST') throw error;
        const old = await this.bytes(await this.owned(destination), MAX_IMAGE);
        if (createHash('sha256').update(old).digest('hex') !== sha256) throw new Error('Stored reference image has changed.');
      }
    } finally { await unlink(temporary).catch(error => { if (error.code !== 'ENOENT') throw error; }); }
    return { path: destination, sha256 };
  }

  async save(input) {
    const data = saveSchema.parse(input);
    if (data.kind === 'location' && data.voice) throw new Error('Locations cannot have a voice.');
    if (!!data.memoryId !== (data.expectedRevision !== undefined)) throw new Error('Updating a memory requires both memoryId and expectedRevision.');
    const previous = data.memoryId ? await this.get({ memoryId: data.memoryId }) : null;
    if (previous && previous.revision !== data.expectedRevision) throw new Error('Memory revision changed. Read the latest revision before retrying.');
    if (previous && previous.kind !== data.kind) throw new Error('Memory kind cannot be changed. Create another memory instead.');
    const references = data.referencePaths === undefined ? previous?.references ?? [] : await Promise.all(data.referencePaths.map(path => this.retain(path)));
    const now = new Date().toISOString();
    return this.publish({ memoryId: previous?.memoryId ?? randomUUID(), revision: previous ? previous.revision + 1 : 1,
      kind: data.kind, name: data.name, description: data.description, notes: data.notes ?? '', tags: [...new Set(data.tags ?? [])],
      ...(data.voice ? { voice: data.voice } : {}), references, archived: previous?.archived ?? false,
      createdAt: previous?.createdAt ?? now, updatedAt: now });
  }

  async archive(input) {
    const { memoryId, expectedRevision, archived } = archiveSchema.parse(input);
    const previous = await this.get({ memoryId });
    if (previous.revision !== expectedRevision) throw new Error('Memory revision changed. Read the latest revision before retrying.');
    return this.publish({ ...previous, revision: previous.revision + 1, archived, updatedAt: new Date().toISOString() });
  }

  async list(input = {}) {
    const { kind, query = '', limit, offset, includeArchived } = listSchema.parse(input);
    let entries;
    try { entries = await readdir(await this.owned(this.root, 'directory'), { withFileTypes: true }); }
    catch (error) { if (error.code === 'ENOENT') return { memories: [], total: 0, nextOffset: null, skippedRecords: 0 }; throw error; }
    const memories = []; let skippedRecords = 0;
    for (const item of entries) {
      if (!uuid.safeParse(item.name).success) continue;
      try {
        const entry = await this.get({ memoryId: item.name });
        if ((!includeArchived && entry.archived) || (kind && entry.kind !== kind) || ![entry.name, entry.description, entry.notes, ...entry.tags].join('\n').toLowerCase().includes(query.toLowerCase())) continue;
        const { references, ...summary } = entry;
        memories.push({ ...summary, referenceCount: references.length });
      } catch { skippedRecords++; }
    }
    memories.sort((a, b) => b.updatedAt.localeCompare(a.updatedAt) || a.memoryId.localeCompare(b.memoryId));
    return { memories: memories.slice(offset, offset + limit), total: memories.length,
      nextOffset: offset + limit < memories.length ? offset + limit : null, skippedRecords };
  }

  async resolveReference(input) {
    const { index, ...selector } = z.strictObject({ ...memorySelector.shape, index: z.number().int().min(0).max(3).default(0) }).parse(input);
    const entry = await this.get(selector), reference = entry.references[index];
    if (!reference) throw new Error('Memory reference index was not found.');
    const path = await this.owned(this.referencePath(reference));
    const bytes = await this.bytes(path, MAX_IMAGE);
    imageExtension(bytes);
    if (createHash('sha256').update(bytes).digest('hex') !== reference.sha256) throw new Error('Stored reference image has changed.');
    return path;
  }
}
