import { frameToSample, validateAudioSegments, MAX_SCENE_SECONDS, MAX_TIMELINE_SECONDS, type AudioMode } from "./audio.js";
export { MAX_AUDIO_SEGMENTS } from "./audio.js";
export type Asset = { filename: string; subfolder: string; type: "input" | "output" | "temp" };
type AudioRange = { id: string; startFrame: number; endFrame: number | null };
export type FileAudioSegment = AudioRange & { kind: "file"; asset: Asset; sourceOffsetSamples: number; name?: string };
export type AudioSegment = (AudioRange & { kind: "generate" }) | FileAudioSegment;
/** Position along the available horizontal and vertical crop travel. */
export type CropPosition = { x: number; y: number; scale?: number };
export type Scene = { id: string; name?: string; prompt: string; durationFrames: number; audioMode?: AudioMode; audioFallbackMode?: "generated" | "silent"; audioGuidance?: boolean; image?: Asset; crop?: CropPosition; endImage?: Asset; endCrop?: CropPosition; sampling?: SceneSampling; imageStrength?: number; endImageStrength?: number };
export const MAX_SCENE_PROMPT_LENGTH = 48000;
export const MAX_SCENE_NAME_LENGTH = 120;
export type SamplingPreset = "auto" | "distilled" | "full";
export type ModelProfile = { preset: "distilled" | "full" | null; reason: string; checkpoint?: string };
export const SAMPLING_PRESETS = Object.freeze({
  distilled: Object.freeze({ steps: 8, cfg: 1 }),
  full: Object.freeze({ steps: 50, cfg: 3 }),
});
export type Sampling = {
  steps: number; cfg: number; sampler: "euler_ancestral" | "euler" | "dpmpp_2m";
  scheduler: "distilled" | "custom"; imageStrength: number;
};
export type SceneSampling = Omit<Sampling, "steps">;
export const DEFAULT_SAMPLING: Readonly<Sampling> = Object.freeze({
  steps: 8, cfg: 1, sampler: "euler_ancestral", scheduler: "distilled", imageStrength: 1,
});
export type Project = {
  version: 3; id: string; title: string; fps: number; width: number; height: number;
  globalPrompt: string; scenes: Scene[];
  audioSegments: AudioSegment[];
  sampling?: Sampling;
  samplingPreset?: SamplingPreset;
  seed: number;
};

export function getSampling(project: Pick<Project, "sampling">, scene?: Pick<Scene, "sampling">): Sampling {
  return { ...DEFAULT_SAMPLING, ...project.sampling, ...scene?.sampling, steps: project.sampling?.steps ?? DEFAULT_SAMPLING.steps };
}

export function getImageStrength(project: Pick<Project, "sampling">, scene: Scene, target: "first" | "last"): number {
  const override = target === "first" ? scene.imageStrength : scene.endImageStrength;
  return override ?? getSampling(project, scene).imageStrength;
}

/** Two endpoint images need distinct output frames. */
export function minSceneFrames(scene: Scene): number {
  return scene.image && scene.endImage ? 2 : 1;
}

/** Pass authored text through unchanged, separated only by a blank line. */
export function assembleScenePrompt(project: Pick<Project, "globalPrompt">, scene: Pick<Scene, "prompt">): string {
  return [project.globalPrompt, scene.prompt].filter(part => part !== "").join("\n\n");
}

export const createScene = (durationFrames = 72): Scene => ({ id: crypto.randomUUID(), prompt: "", durationFrames });
export function sceneName(scene: Scene, index: number): string {
  return scene.name?.trim() || `Clip ${index + 1}`;
}
export const newProject = (): Project => ({
  version: 3, id: crypto.randomUUID(), title: "Garden morning", fps: 24, width: 1024,
  height: 576, samplingPreset: "auto", seed: 42,
  globalPrompt: "A peaceful morning in a sunlit garden. Natural colors, soft golden light, and realistic cinematic photography.",
  scenes: [
    { ...createScene(120), name: "Garden path", prompt: "A wide shot of a garden path surrounded by flowers. A gentle breeze moves the petals and leaves as the camera slowly glides forward. Birds chirp in the distance." },
    { ...createScene(120), name: "Butterfly", prompt: "A close-up of a butterfly resting on a flower. It slowly opens and closes its wings while the flower sways gently. The camera stays steady, with soft birdsong in the background." },
  ],
  audioSegments: [{ id: crypto.randomUUID(), kind: "generate", startFrame: 0, endFrame: null }],
});

export function totalFrames(project: Project): number {
  return project.scenes.reduce((sum, scene) => sum + scene.durationFrames, 0);
}
export function sceneStartFrame(project: Project, index: number): number {
  return project.scenes.slice(0, Math.max(0, index)).reduce((sum, scene) => sum + scene.durationFrames, 0);
}
export function sceneAtFrame(project: Project, frame: number) {
  let startFrame = 0;
  for (let index = 0; index < project.scenes.length; index++) {
    const scene = project.scenes[index]!;
    const endFrame = startFrame + scene.durationFrames;
    if (frame >= startFrame && frame < endFrame) return { scene, index, startFrame, endFrame };
    startFrame = endFrame;
  }
  return undefined;
}
export function framesForGeneration(durationFrames: number): number {
  if (!Number.isInteger(durationFrames) || durationFrames < 1) throw new Error("Duration must be a positive integer.");
  return Math.max(9, Math.ceil((durationFrames - 1) / 8) * 8 + 1);
}
export function formatTime(frame: number, fps: number): string {
  const safe = Math.max(0, Math.floor(frame));
  const seconds = Math.floor(safe / fps);
  return `${Math.floor(seconds / 60).toString().padStart(2, "0")}:${(seconds % 60).toString().padStart(2, "0")}:${(safe % fps).toString().padStart(2, "0")}`;
}
export function formatDuration(frames: number, fps: number): string {
  return (frames / fps).toFixed(1);
}
export function formatPlaybackTime(frame: number, fps: number): string {
  const tenths = Math.round(Math.max(0, frame) * 10 / fps);
  return `${Math.floor(tenths / 600)}:${Math.floor(tenths / 10 % 60).toString().padStart(2, "0")}.${tenths % 10}`;
}
export function durationFramesFromSeconds(seconds: number, fps: number, currentFrames: number): number {
  // Merely confirming a rounded display must not change the exact duration.
  return seconds === Number(formatDuration(currentFrames, fps)) ? currentFrames : Math.round(seconds * fps);
}
export function assetUrl(asset: Asset): string {
  return `/happylatent/assets?${new URLSearchParams(asset)}`;
}

function object(value: unknown): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error("Expected a project object.");
  return value as Record<string, unknown>;
}
function text(value: unknown, field: string, max = 16000): string {
  if (typeof value !== "string" || value.length > max) throw new Error(`${field} must be text of at most ${max} characters.`);
  return value;
}
function integer(value: unknown, field: string, min: number, max: number): number {
  if (!Number.isSafeInteger(value) || (value as number) < min || (value as number) > max) throw new Error(`${field} must be an integer from ${min} to ${max}.`);
  return value === 0 ? 0 : value as number;
}
function number(value: unknown, field: string, min: number, max: number): number {
  if (typeof value !== "number" || !Number.isFinite(value) || value < min || value > max) throw new Error(`${field} must be a number from ${min} to ${max}.`);
  return value === 0 ? 0 : value;
}
function sampling(value: unknown): Sampling {
  const source = object(value);
  const result = {
    ...DEFAULT_SAMPLING,
    ...source,
    steps: integer(source.steps === undefined ? DEFAULT_SAMPLING.steps : source.steps, "Steps", 2, 100),
    cfg: number(source.cfg === undefined ? DEFAULT_SAMPLING.cfg : source.cfg, "CFG", 0, 30),
    imageStrength: number(source.imageStrength === undefined ? DEFAULT_SAMPLING.imageStrength : source.imageStrength, "Image strength", 0, 1),
  };
  if (!["euler_ancestral", "euler", "dpmpp_2m"].includes(result.sampler)) throw new Error("Unsupported sampler.");
  if (!["distilled", "custom"].includes(result.scheduler)) throw new Error("Unsupported scheduler.");
  if (result.scheduler === "distilled" && result.steps !== 8) throw new Error("The distilled schedule requires 8 steps.");
  return { steps: result.steps, cfg: result.cfg, sampler: result.sampler, scheduler: result.scheduler, imageStrength: result.imageStrength };
}
function sceneSampling(value: unknown, global: Sampling): SceneSampling {
  const source = object(value);
  if (Object.hasOwn(source, "steps")) throw new Error("Steps are global and cannot be set per clip.");
  const result = sampling({ ...global, ...source });
  return { cfg: result.cfg, sampler: result.sampler, scheduler: result.scheduler, imageStrength: result.imageStrength };
}
function cropPosition(value: unknown): CropPosition {
  const source = object(value);
  return { x: number(source.x, "Crop horizontal position", 0, 1), y: number(source.y, "Crop vertical position", 0, 1),
    ...(Object.hasOwn(source, "scale") ? { scale: number(source.scale, "Crop size", 0.1, 1) } : {}),
  };
}
export function validateAsset(value: unknown): Asset {
  const source = object(value);
  const filename = text(source.filename, "Filename", 255);
  const subfolder = text(source.subfolder === undefined ? "happylatent" : source.subfolder, "Subfolder", 255);
  if (!filename.trim() || /[/\\\u0000\[\]]/.test(filename) || filename === "." || filename === "..") throw new Error("Invalid asset filename.");
  if (/\\|\u0000/.test(subfolder) || subfolder.startsWith("/") || subfolder.split("/").includes("..")) throw new Error("Invalid asset folder.");
  const normalized = subfolder.split("/").filter(part => part && part !== ".").join("/");
  if (normalized.split("/")[0] !== "happylatent") throw new Error("Assets must belong to the happylatent folder.");
  if ((source.type === undefined ? "input" : source.type) !== "input") throw new Error("Project assets must be input files.");
  return { filename, subfolder: normalized, type: "input" };
}
function scenePrompt(row: Record<string, unknown>): string {
  const parts = [text(row.prompt === undefined ? "" : row.prompt, "Clip prompt", MAX_SCENE_PROMPT_LENGTH)];
  // Older v3 projects stored shot cards; retain their authored text on import.
  if (Object.hasOwn(row, "shots")) {
    if (!Array.isArray(row.shots)) throw new Error("Legacy shots must be an array.");
    for (const entry of row.shots) {
      const shot = object(entry);
      parts.push(text(shot.prompt === undefined ? "" : shot.prompt, "Legacy shot prompt"));
      if (Object.hasOwn(shot, "audio")) parts.push(text(shot.audio, "Legacy shot audio"));
    }
  }
  return text(parts.filter(part => part !== "").join("\n\n"), "Clip prompt", MAX_SCENE_PROMPT_LENGTH);
}
function parseProject(value: unknown, maxSceneSeconds: number): Project {
  const source = object(value);
  if (source.version !== 1 && source.version !== 2 && source.version !== 3) throw new Error("This project version is not supported.");
  if (source.version !== 1 && Object.hasOwn(source, "audio")) throw new Error("Projects version 2 and later use audioSegments instead of audio.");
  if (source.version === 1 && Object.hasOwn(source, "audioSegments")) throw new Error("Audio segments require project version 2.");
  if (!Array.isArray(source.scenes) || source.scenes.length < 1 || source.scenes.length > 100) throw new Error("A project needs between 1 and 100 clips.");
  const globalSampling = Object.hasOwn(source, "sampling") ? sampling(source.sampling) : undefined;
  const fps = integer(source.fps, "Frame rate", 1, 60);
  const ids = new Set<string>();
  const scenes = source.scenes.map((value): Scene => {
    const row = object(value);
    if (Object.hasOwn(row, "keyframes") && (!Array.isArray(row.keyframes) || row.keyframes.length !== 0)) {
      throw new Error("Intermediate image keyframes are no longer supported. Remove them from this project or use the archived version.");
    }
    const id = text(row.id, "Clip ID", 128);
    if (!id.trim() || ids.has(id)) throw new Error("Clip IDs must be nonempty and unique.");
    ids.add(id);
    const name = Object.hasOwn(row, "name") ? text(row.name, "Clip name", MAX_SCENE_NAME_LENGTH).trim() : "";
    if (!Number.isSafeInteger(row.durationFrames) || (row.durationFrames as number) < 1 || (row.durationFrames as number) > fps * maxSceneSeconds) throw new Error(`Clip duration must be between one frame and ${maxSceneSeconds} seconds (${fps * maxSceneSeconds} frames).`);
    const durationFrames = row.durationFrames as number;
    if (Object.hasOwn(row, "audioMode") && !["generated", "supplied", "silent"].includes(row.audioMode as string)) throw new Error("Clip audio mode must be generated, supplied, or silent.");
    if (Object.hasOwn(row, "audioFallbackMode") && !["generated", "silent"].includes(row.audioFallbackMode as string)) throw new Error("Clip audio fallback must be generated or silent.");
    if (Object.hasOwn(row, "audioGuidance") && typeof row.audioGuidance !== "boolean") throw new Error("Clip audio guidance must be a boolean.");
    if (durationFrames === 1 && row.image != null && row.endImage != null) throw new Error("First and last frame images require a clip of at least 2 frames.");
    return {
      id, ...(name ? { name } : {}), prompt: scenePrompt(row),
      durationFrames,
      ...(Object.hasOwn(row, "audioMode") ? { audioMode: row.audioMode as AudioMode } : {}),
      ...(Object.hasOwn(row, "audioFallbackMode") ? { audioFallbackMode: row.audioFallbackMode as "generated" | "silent" } : {}),
      ...(Object.hasOwn(row, "audioGuidance") ? { audioGuidance: row.audioGuidance as boolean } : {}),
      ...(row.image != null ? { image: validateAsset(row.image) } : {}),
      ...(Object.hasOwn(row, "crop") ? { crop: cropPosition(row.crop) } : {}),
      ...(row.endImage != null ? { endImage: validateAsset(row.endImage) } : {}),
      ...(Object.hasOwn(row, "endCrop") ? { endCrop: cropPosition(row.endCrop) } : {}),
      ...(Object.hasOwn(row, "imageStrength") ? { imageStrength: number(row.imageStrength, "First image strength", 0, 1) } : {}),
      ...(Object.hasOwn(row, "endImageStrength") ? { endImageStrength: number(row.endImageStrength, "Last image strength", 0, 1) } : {}),
      ...(Object.hasOwn(row, "sampling") ? { sampling: sceneSampling(row.sampling, globalSampling ?? DEFAULT_SAMPLING) } : {}),
    };
  });
  const result: Project = {
    version: 3, id: text(source.id, "Project ID", 128), title: text(source.title === undefined ? "Untitled project" : source.title, "Title", 200),
    fps, width: integer(source.width, "Width", 64, 4096),
    height: integer(source.height, "Height", 64, 4096), globalPrompt: text(source.globalPrompt === undefined ? "" : source.globalPrompt, "Global prompt"),
    scenes, seed: integer(source.seed === undefined ? 0 : source.seed, "Seed", 0, Number.MAX_SAFE_INTEGER), audioSegments: [],
  };
  for (const scene of scenes) text(assembleScenePrompt(result, scene), "Combined clip prompt", MAX_SCENE_PROMPT_LENGTH);
  if (result.width % 32 || result.height % 32) throw new Error("Width and height must be multiples of 32.");
  if (!result.id.trim()) throw new Error("Project ID must be nonempty.");
  if (source.version !== 1) result.audioSegments = validateAudioSegments(source.audioSegments, result.fps, validateAsset);
  else if (source.audio != null) {
    const row = object(source.audio);
    result.audioSegments = [{ id: "legacy-audio", kind: "file", asset: validateAsset(row.asset),
      startFrame: integer(row.offsetFrames === undefined ? 0 : row.offsetFrames, "Audio offset", 0, result.fps * MAX_TIMELINE_SECONDS), endFrame: null,
      sourceOffsetSamples: frameToSample(integer(row.trimStartFrames === undefined ? 0 : row.trimStartFrames, "Audio trim", 0, result.fps * 600), result.fps) }];
  }
  if (globalSampling) result.sampling = globalSampling;
  if (Object.hasOwn(source, "samplingPreset")) {
    if (!["auto", "distilled", "full"].includes(source.samplingPreset as string)) throw new Error("Sampling preset must be auto, distilled, or full.");
    result.samplingPreset = source.samplingPreset as SamplingPreset;
  }
  return result;
}

export function validateProject(value: unknown): Project { return parseProject(value, MAX_SCENE_SECONDS); }

/** Restore formerly valid workflows without changing their media or timing. */
export function readProject(value: unknown): Project { return parseProject(value, 60); }

/** Existing oversized scenes can be repaired incrementally, but never extended. */
export function validateProjectEdit(value: unknown, previous: Project): Project {
  const next = readProject(value);
  for (const scene of next.scenes) {
    if (scene.durationFrames <= next.fps * MAX_SCENE_SECONDS) continue;
    const original = previous.scenes.find(row => row.id === scene.id);
    if (!original || scene.durationFrames > Math.round(original.durationFrames * next.fps / previous.fps)) {
      throw new Error(`A clip cannot exceed ${MAX_SCENE_SECONDS} seconds. Shorten it or add another clip.`);
    }
  }
  return next;
}

export class History {
  private past: Project[] = [];
  private future: Project[] = [];
  private current: Project;
  constructor(project: Project) { this.current = structuredClone(project); }
  get value(): Project { return structuredClone(this.current); }
  get canUndo(): boolean { return this.past.length > 0; }
  get canRedo(): boolean { return this.future.length > 0; }
  commit(project: Project): void {
    if (JSON.stringify(project) === JSON.stringify(this.current)) return;
    this.past.push(this.current);
    if (this.past.length > 100) this.past.shift();
    this.current = structuredClone(project);
    this.future = [];
  }
  undo(): Project {
    if (this.past.length) { this.future.push(this.current); this.current = this.past.pop()!; }
    return this.value;
  }
  redo(): Project {
    if (this.future.length) { this.past.push(this.current); this.current = this.future.pop()!; }
    return this.value;
  }
}
