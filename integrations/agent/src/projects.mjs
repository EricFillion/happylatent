import { randomUUID } from "node:crypto";
import { link, mkdir, readFile, readdir, unlink, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { readProject, validateProject, validateProjectEdit } from "../resources/project-core/domain.js";
import {
  placeProvidedAudio, reconcileProvidedAudio, reflowSceneAudio, setSceneAudioMode,
  validateAudioModeEdit, sceneAudioConflict, audioModeError,
} from "../resources/project-core/audio.js";
import { renderPlan, videoTake } from "./clips.mjs";
import { validateSceneMemory, projectWithMemory } from "./scene-memory.mjs";

const projectIdPattern = /^[a-f0-9]{8}(?:-[a-f0-9]{4}){3}-[a-f0-9]{12}$/;
const revisionPattern = /^[1-9][0-9]*\.json$/;

export function validateForGeneration(project, options = {}) {
  const canonical = validateProject(project);
  const generated = new Set(renderPlan(canonical, options).generated.map(scene => scene.id));
  for (const scene of canonical.scenes) if (generated.has(scene.id)) {
    if (scene.durationFrames > canonical.fps * 20) throw new Error("Generated clips cannot exceed 20 seconds. Split this clip before generating.");
    if (scene.durationFrames === 1 && scene.image && scene.endImage) throw new Error("First and last frame images require at least two frames when generating.");
  }
  const conflict = canonical.scenes.findIndex((scene, index) => generated.has(scene.id) && sceneAudioConflict(canonical, index));
  if (conflict !== -1) throw new Error(audioModeError(conflict));
  return canonical;
}

function draftScene(input) {
  return { ...input, id: randomUUID() };
}

function createDraft({ scenes, ...settings }) {
  const draft = {
    version: scenes.some(scene => scene.video) ? 4 : 3, id: randomUUID(), title: "Untitled project",
    width: 256, height: 256, fps: 24, seed: 42, samplingPreset: "auto", ...settings,
    scenes: scenes.map((scene) => draftScene({ audioMode: "generated", ...scene })), audioSegments: [],
  };
  let startFrame = 0;
  for (const scene of draft.scenes) {
    const endFrame = startFrame + scene.durationFrames;
    if (scene.audioMode === "generated") draft.audioSegments.push({
      id: randomUUID(), kind: "generate", startFrame, endFrame,
    });
    startFrame = endFrame;
  }
  return validateForGeneration(draft);
}

function sceneIndex(project, sceneId) {
  const index = project.scenes.findIndex((scene) => scene.id === sceneId);
  if (index === -1) throw new Error(`Scene ${sceneId} is not in this project.`);
  return index;
}

function insertAt(project, scene, beforeSceneId) {
  const index = beforeSceneId ? sceneIndex(project, beforeSceneId) : project.scenes.length;
  return [...project.scenes.slice(0, index), scene, ...project.scenes.slice(index)];
}

function replaceScene(scene, patch) {
  const updated = { ...scene, ...patch };
  for (const [image, crop] of [["image", "crop"], ["endImage", "endCrop"]]) {
    if (patch[image] === null) {
      delete updated[image];
      delete updated[crop];
    } else if (patch[crop] === null) {
      delete updated[crop];
    }
  }
  if (patch.video === null) delete updated.video;
  return updated;
}

function applyOperation(project, operation) {
  switch (operation.op) {
    case "update_project":
      return { ...project, ...operation.patch };
    case "add_scene":
      return { ...project, ...(operation.scene.video ? { version: 4 } : {}), scenes: insertAt(project, draftScene(operation.scene), operation.beforeSceneId) };
    case "add_clip": {
      const take = videoTake(operation.clip);
      const sourceStartFrame = operation.sourceStartFrame ?? 0;
      const durationFrames = operation.durationFrames ?? Math.floor((take.frameCount - sourceStartFrame) * project.fps / take.fps + 1e-8);
      const scene = draftScene({ name: operation.name ?? take.name ?? 'Existing clip', prompt: '', durationFrames,
        audioMode: 'silent', video: { ...take, sourceStartFrame } });
      return { ...project, version: 4, scenes: insertAt(project, scene, operation.beforeSceneId) };
    }
    case "choose_take": {
      const index = sceneIndex(project, operation.sceneId);
      const scenes = [...project.scenes];
      scenes[index] = { ...scenes[index], video: { ...videoTake(operation.clip), sourceStartFrame: operation.sourceStartFrame ?? 0 } };
      return { ...project, version: 4, scenes };
    }
    case "detach_take": {
      const index = sceneIndex(project, operation.sceneId);
      const scenes = [...project.scenes];
      scenes[index] = replaceScene(scenes[index], { video: null });
      return { ...project, scenes };
    }
    case "update_scene": {
      const index = sceneIndex(project, operation.sceneId);
      const scenes = [...project.scenes];
      scenes[index] = replaceScene(scenes[index], operation.patch);
      return { ...project, ...(operation.patch.video ? { version: 4 } : {}), scenes };
    }
    case "move_scene": {
      const index = sceneIndex(project, operation.sceneId);
      if (operation.beforeSceneId === operation.sceneId) return project;
      const remaining = { ...project, scenes: project.scenes.filter((_, i) => i !== index) };
      return { ...project, scenes: insertAt(remaining, project.scenes[index], operation.beforeSceneId) };
    }
    case "remove_scene": {
      const index = sceneIndex(project, operation.sceneId);
      return { ...project, scenes: project.scenes.filter((_, i) => i !== index) };
    }
    case "set_scene_audio":
      return setSceneAudioMode(project, sceneIndex(project, operation.sceneId), operation.mode);
    case "place_audio": {
      const id = operation.audioId ?? randomUUID();
      if (project.audioSegments.some((segment) => segment.id === id && segment.kind !== "file")) {
        throw new Error(`Audio block ${id} is generated. Choose a new ID or a supplied audio block.`);
      }
      return placeProvidedAudio(project, {
        id, kind: "file", asset: operation.asset, startFrame: operation.startFrame, endFrame: operation.endFrame,
        sourceOffsetSamples: operation.sourceOffsetSamples ?? 0,
        ...(operation.name !== undefined ? { name: operation.name } : {}),
      });
    }
    case "remove_audio": {
      const source = project.audioSegments.find((segment) => segment.id === operation.audioId);
      if (source?.kind !== "file") throw new Error(`Supplied audio block ${operation.audioId} was not found. Use set_scene_audio for generated audio.`);
      const audioSegments = project.audioSegments.filter((segment) => segment.id !== source.id);
      return reconcileProvidedAudio({ ...project, audioSegments }, project);
    }
    case "place_music": {
      const { op, musicId, ...settings } = operation;
      const id = musicId ?? randomUUID();
      return { ...project, musicSegments: [...(project.musicSegments ?? []).filter(segment => segment.id !== id),
        { ...settings, id }] };
    }
    case "remove_music": {
      if (!(project.musicSegments ?? []).some(segment => segment.id === operation.musicId)) {
        throw new Error(`Music block ${operation.musicId} was not found.`);
      }
      return { ...project, musicSegments: project.musicSegments.filter(segment => segment.id !== operation.musicId) };
    }
    default:
      throw new Error(`Unsupported edit operation ${operation.op}.`);
  }
}

function editDraft(project, operations) {
  return operations.reduce((previous, operation) => {
    const parsed = validateProjectEdit(applyOperation(previous, operation), previous);
    const reflowed = reflowSceneAudio(parsed, previous);
    return validateAudioModeEdit(reflowed === parsed ? parsed : validateProjectEdit(reflowed, previous), previous);
  }, project);
}

export class Projects {
  constructor(stateDir) {
    this.root = join(stateDir, "projects");
  }

  directory(projectId) {
    if (!projectIdPattern.test(projectId)) throw new Error("Invalid project ID.");
    return join(this.root, projectId);
  }

  async latestRevision(projectId) {
    let names;
    try {
      names = await readdir(this.directory(projectId));
    } catch (error) {
      if (error.code !== "ENOENT") throw error;
      throw new Error(`Project ${projectId} was not found.`);
    }
    const revision = names.reduce((latest, name) => {
      if (!revisionPattern.test(name)) return latest;
      const number = Number(name.slice(0, -5));
      return Number.isSafeInteger(number) ? Math.max(number, latest) : latest;
    }, 0);
    if (!revision) throw new Error(`Project ${projectId} was not found.`);
    return revision;
  }

  async get(projectId, revision) {
    const directory = this.directory(projectId);
    const selected = revision ?? await this.latestRevision(projectId);
    if (!Number.isSafeInteger(selected) || selected < 1) throw new Error("Invalid project revision.");
    let snapshot;
    try {
      snapshot = JSON.parse(await readFile(join(directory, `${selected}.json`), "utf8"));
    } catch (error) {
      if (error.code !== "ENOENT") throw error;
      throw new Error(`Project ${projectId} revision ${selected} was not found.`);
    }
    if (snapshot.project?.id !== projectId || snapshot.revision !== selected) {
      throw new Error(`Stored project ${projectId} revision ${selected} has mismatched identifiers.`);
    }
    const project = readProject(snapshot.project);
    const sceneMemory = validateSceneMemory(project, snapshot.sceneMemory);
    return { projectId, revision: selected, project,
      ...(Object.keys(sceneMemory).length ? { sceneMemory } : {}) };
  }

  async write(project, revision, bindings = {}) {
    const sceneMemory = validateSceneMemory(project, bindings);
    if (Object.keys(sceneMemory).length) readProject(projectWithMemory({ project, sceneMemory }));
    const directory = this.directory(project.id);
    await mkdir(directory, { recursive: true, mode: 0o700 });
    const temporary = join(directory, `.${randomUUID()}.tmp`);
    const snapshot = { projectId: project.id, revision, project,
      ...(Object.keys(sceneMemory).length ? { sceneMemory } : {}) };
    const serialized = JSON.stringify(snapshot) + "\n";
    if (Buffer.byteLength(serialized) > 8 * 1024 * 1024) throw new Error('Project with memory exceeds the 8 MiB saved-project limit. Shorten descriptions/notes or use fewer assignments.');
    try {
      await writeFile(temporary, serialized, { flag: "wx", mode: 0o600, flush: true });
      // Publishing with a hard link makes complete snapshots visible atomically.
      // Only one caller can publish a given revision across server processes.
      await link(temporary, join(directory, `${revision}.json`));
    } finally {
      await unlink(temporary).catch((error) => {
        if (error.code !== "ENOENT") console.error(`Unable to clean project temp file: ${error.message}`);
      });
    }
    return snapshot;
  }

  async create(settings) {
    return this.write(createDraft(settings), 1);
  }

  async import(raw, sceneMemory) {
    const project = { ...readProject(raw), id: randomUUID() };
    return this.write(project, 1, sceneMemory);
  }

  async setMemory(projectId, expectedRevision, sceneIds, binding) {
    const current = await this.get(projectId);
    if (expectedRevision !== current.revision) throw new Error(`Project revision changed to ${current.revision}. Read the latest project before retrying the edit.`);
    if (!Array.isArray(sceneIds) || !sceneIds.length || sceneIds.length > 100 || new Set(sceneIds).size !== sceneIds.length) throw new Error('Choose 1–100 distinct scene IDs.');
    const sceneMemory = structuredClone(current.sceneMemory ?? {});
    for (const sceneId of sceneIds) {
      sceneIndex(current.project, sceneId);
      Object.defineProperty(sceneMemory, sceneId, { value: binding, enumerable: true, configurable: true, writable: true });
    }
    const checked = validateSceneMemory(current.project, sceneMemory);
    for (const sceneId of sceneIds) {
      const entry = checked[sceneId];
      if (!entry.characters.length && !entry.location && !entry.notes) delete checked[sceneId];
    }
    try { return await this.write(current.project, current.revision + 1, checked); }
    catch (error) {
      if (error.code !== 'EEXIST') throw error;
      throw new Error('Another edit changed this project. Read the latest project before retrying the edit.');
    }
  }

  async edit(projectId, expectedRevision, operations) {
    const current = await this.get(projectId);
    if (expectedRevision !== current.revision) {
      throw new Error(`Project revision changed to ${current.revision}. Read the latest project before retrying the edit.`);
    }
    const changed = editDraft(current.project, operations);
    try {
      const remaining = new Set(changed.scenes.map(scene => scene.id));
      const bindings = Object.fromEntries(Object.entries(current.sceneMemory ?? {}).filter(([id]) => remaining.has(id)));
      return await this.write(changed, current.revision + 1, bindings);
    } catch (error) {
      if (error.code !== "EEXIST") throw error;
      throw new Error("Another edit changed this project. Read the latest project before retrying the edit.");
    }
  }
}
