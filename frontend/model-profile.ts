import type { ModelProfile } from "./domain.js";

type Link = { origin_id: string | number; origin_slot: number };
type GraphNode = {
  id: string | number; comfyClass?: string; type?: string; mode?: number;
  inputs?: { name: string; type?: string; link?: string | number | null }[];
  widgets?: { name: string; value: unknown }[];
  graph?: { links: Record<string | number, Link>; getNodeById(id: string | number): GraphNode | null };
};
type ApiNode = { class_type: string; inputs: Record<string, unknown> };

/** Read only model-related fields. Never serialize the project, assets, or credentials. */
export function modelProfileRequest(editor: GraphNode) {
  const graph = editor.graph;
  const prompt: Record<string, ApiNode> = Object.create(null);
  const modelInput = editor.inputs?.find(input => input.name === "model");
  function linkFor(id: string | number | null | undefined): [string, number] | null {
    const link = id == null ? undefined : graph?.links?.[id];
    return link ? [String(link.origin_id), link.origin_slot] : null;
  }
  const model = linkFor(modelInput?.link);
  const pending = model ? [model[0]] : [];
  while (pending.length && Object.keys(prompt).length < 128) {
    const id = pending.pop()!;
    if (Object.hasOwn(prompt, id)) continue;
    const node = graph?.getNodeById(id);
    if (!node) continue;
    const inputs: Record<string, unknown> = Object.create(null);
    // Match ComfyUI bypass only for an unambiguous single MODEL input.
    const modelInputs = node.inputs?.filter(input => input.type === "MODEL") ?? [];
    const bypass = node.mode === 4 && modelInputs.length === 1;
    const kind = bypass ? "Reroute" : node.mode === 4 ? "AmbiguousBypass" : node.mode === 2 ? "Muted" : node.comfyClass ?? node.type ?? "";
    if (!bypass) for (const widget of node.widgets ?? []) {
      if (["unet_name", "ckpt_name", "strength_model"].includes(widget.name)) {
        inputs[widget.name] = typeof widget.value === "string" ? widget.value.slice(0, 4097) : typeof widget.value === "number" ? widget.value : null;
      }
    }
    for (const input of bypass ? modelInputs : node.inputs ?? []) {
      if (!bypass && input.type !== "MODEL" && !["model", "unet_name", "ckpt_name", "strength_model"].includes(input.name) && kind !== "Reroute") continue;
      const link = linkFor(input.link);
      if (link) { inputs[bypass ? "model" : input.name] = link; pending.push(link[0]); }
    }
    prompt[id] = { class_type: kind, inputs };
  }
  return { model, prompt };
}

/** Upstream widget edits don't notify downstream nodes. Poll the small snapshot,
 * requesting a new profile only when its contents change. Backend is authoritative. */
export function watchModelProfile(editor: GraphNode, update: (profile: ModelProfile) => void): () => void {
  let signature = "";
  let request: AbortController | undefined;
  let disposed = false;
  let retryAt = 0;
  function refresh() {
    if (disposed) return;
    const payload = modelProfileRequest(editor);
    const next = JSON.stringify(payload);
    if (next === signature || Date.now() < retryAt) return;
    signature = next;
    request?.abort();
    const controller = request = new AbortController();
    update({ preset: null, reason: payload.model ? "Checking connected model…" : "Connect a model, or choose Distilled or Full." });
    if (!payload.model) return;
    void fetch("/happylatent/model-profile", {
      method: "POST", headers: { "Content-Type": "application/json" }, body: next, signal: AbortSignal.any([controller.signal, AbortSignal.timeout(10_000)]),
    }).then(async response => {
      if (!response.ok) throw new Error("Model detection unavailable.");
      const profile = await response.json() as ModelProfile;
      if (![null, "distilled", "full"].includes(profile.preset) || typeof profile.reason !== "string") throw new Error("Invalid model profile.");
      if (!disposed && !controller.signal.aborted && signature === next) {
        if (JSON.stringify(modelProfileRequest(editor)) !== next) { refresh(); return; }
        update(profile);
      }
    }).catch(() => {
      if (!disposed && !controller.signal.aborted && signature === next) {
        update({ preset: null, reason: "Model detection unavailable. Choose Distilled or Full." });
        signature = ""; retryAt = Date.now() + 5000;
      }
    });
  }
  refresh();
  const timer = setInterval(refresh, 1000);
  return () => { disposed = true; clearInterval(timer); request?.abort(); };
}
