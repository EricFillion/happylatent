import type { Project } from "./domain.js";
type RenderMode = "generate" | "selected" | "export";

export type ApiNode = { class_type: string; inputs: Record<string, unknown>; [key: string]: unknown };
export type ApiPrompt = Record<string, ApiNode>;
const link = (value: unknown): value is [string, number] => Array.isArray(value) && value.length === 2 && typeof value[0] === "string" && Number.isInteger(value[1]);

/** Isolate this editor's explicit operation. Nothing is written to the live graph. */
export function buildClipPrompt(output: ApiPrompt, nodeId: string, project: Project, mode: RenderMode, sceneIds: string[], runId: string): { output: ApiPrompt; saveId: string } {
  const original = output[nodeId];
  if (!original || original.class_type !== "HappyLatentVideo") throw new Error("The Happy Latent node is missing from the runnable graph.");
  const source = structuredClone(output);
  const inputs = source[nodeId]!.inputs;
  Object.assign(inputs, { project: JSON.stringify(project), render_mode: mode, scene_ids: JSON.stringify(sceneIds), run_id: runId });
  if (mode === "export" || mode === "generate" && project.scenes.every(scene => scene.video)) {
    for (const name of ["model", "clip", "video_vae", "audio_vae", "upscale_model", "temporal_upscale_model"]) delete inputs[name];
    inputs.upscale_enabled = false; inputs.refine_enabled = false;
  }
  const kept: ApiPrompt = {}, pending = [nodeId];
  while (pending.length) {
    const id = pending.pop()!;
    if (kept[id]) continue;
    const entry = source[id];
    if (!entry) throw new Error(`The video graph refers to a missing node (${id}).`);
    kept[id] = entry;
    for (const value of Object.values(entry.inputs)) if (link(value)) pending.push(value[0]);
  }
  let saveId = "happylatent_save";
  while (source[saveId]) saveId += "_";
  kept[saveId] = { class_type: "SaveVideo", inputs: { video: [nodeId, 0], filename_prefix: `happylatent/exports/${runId}`, format: "mp4", "format.codec": "auto" } };
  return { output: kept, saveId };
}
