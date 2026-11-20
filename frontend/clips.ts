import { availableVideoFrames, createScene, validateVideoTake, type Project, type Scene, type VideoTake } from "./domain.js";

async function request(url: string, init?: RequestInit): Promise<any> {
  const response = await fetch(url, init);
  const result = await response.json().catch(() => ({}));
  if (!response.ok) throw new Error(result.error ?? result.message ?? `Clip request failed (${response.status}).`);
  return result;
}
export async function listVideoTakes(): Promise<VideoTake[]> {
  const response = await request("/happylatent/clips");
  if (!Array.isArray(response.clips)) throw new Error("The clip library returned an invalid response.");
  return response.clips.map(validateVideoTake);
}
export async function importVideoTake(file: File): Promise<VideoTake> {
  const body = new FormData(); body.append("file", file);
  return validateVideoTake((await request("/happylatent/assets?kind=video", { method: "POST", body })).clip);
}
export function chooseVideoTake(project: Project, sceneId: string, take: VideoTake, sourceStartFrame = 0): Project {
  const video = { ...validateVideoTake(take), sourceStartFrame };
  const available = availableVideoFrames(video, project.fps);
  const scene = project.scenes.find(row => row.id === sceneId);
  if (!scene) throw new Error("The destination clip no longer exists.");
  if (scene.durationFrames > available) throw new Error("This take is shorter than the timeline clip. Shorten the clip first, or add this take as a new clip.");
  return { ...project, version: 4, scenes: project.scenes.map(row => row.id === sceneId ? { ...row, video } : row) };
}
export function addVideoTake(project: Project, take: VideoTake): { project: Project; scene: Scene } {
  const video = { ...validateVideoTake(take), sourceStartFrame: 0 };
  const durationFrames = availableVideoFrames(video, project.fps);
  if (durationFrames < 1) throw new Error("This video is shorter than one timeline frame.");
  const scene: Scene = { ...createScene(durationFrames), name: take.name?.slice(0, 120) || take.asset.filename.slice(0, 120), audioMode: "silent", video };
  return { project: { ...project, version: 4, scenes: [...project.scenes, scene] }, scene };
}
/** Compare the generation recipe, excluding display names and the selected output. */
export function sceneRecipeKey(project: Project, id: string): string {
  const index = project.scenes.findIndex(scene => scene.id === id), scene = project.scenes[index];
  if (!scene) return "";
  const { video: _video, name: _name, ...recipe } = scene;
  const start = project.scenes.slice(0, index).reduce((sum, row) => sum + row.durationFrames, 0), end = start + scene.durationFrames;
  return JSON.stringify({ recipe, fps: project.fps, width: project.width, height: project.height, seed: project.seed,
    effectiveSeed: (project.seed + index) % 2 ** 53, globalPrompt: project.globalPrompt, sampling: project.sampling, samplingPreset: project.samplingPreset,
    audio: project.audioSegments.filter(row => row.startFrame < end && (row.endFrame ?? Infinity) > start).map(row => ({ ...row, startFrame: row.startFrame - start, endFrame: row.endFrame === null ? null : row.endFrame - start })),
  });
}
