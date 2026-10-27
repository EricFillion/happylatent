import { type Asset, validateAsset } from "./domain.js";

export type Upload = { asset: Asset; url: string; duration?: number; sampleCount?: number; sampleRate?: number };

async function request<T>(url: string, init?: RequestInit): Promise<T> {
  const response = await fetch(url, init);
  if (!response.ok) {
    let message = `${response.status} ${response.statusText}`;
    try {
      const body = await response.json() as { error?: unknown; message?: unknown } | null;
      const detail = [body?.error, body?.message].find(value => typeof value === "string" && value.trim());
      if (typeof detail === "string") message = detail;
    } catch { /* The status remains useful for non-JSON errors. */ }
    throw new Error(message);
  }
  return response.json() as Promise<T>;
}
export async function uploadAsset(file: File, kind: "image" | "audio"): Promise<Upload> {
  const data = new FormData();
  data.append("file", file);
  const result = await request<unknown>(`/happylatent/assets?kind=${kind}`, { method: "POST", body: data });
  if (!result || typeof result !== "object" || Array.isArray(result)) throw new Error("The upload server returned an invalid response.");
  const body = result as Record<string, unknown>;
  try {
    const asset = validateAsset(body.asset);
    if (typeof body.url !== "string" || !body.url) throw new Error("Missing asset URL.");
    if (body.duration !== undefined && (typeof body.duration !== "number" || !Number.isFinite(body.duration) || body.duration < 0)) throw new Error("Invalid audio duration.");
    for (const key of ["sampleCount", "sampleRate"] as const) if (body[key] !== undefined && (typeof body[key] !== "number" || !Number.isSafeInteger(body[key]) || (body[key] as number) <= 0)) throw new Error(`Invalid audio ${key}.`);
    if (kind === "audio" && (body.sampleCount === undefined || body.sampleRate !== 48000)) throw new Error("Missing normalized 48 kHz audio metadata.");
    if (kind === "audio" && (body.sampleCount as number) > 600 * 48000) throw new Error("Audio duration cannot exceed 10 minutes.");
    if (kind === "audio" && body.duration !== undefined && Math.abs((body.duration as number) - (body.sampleCount as number) / 48000) > 1 / 48000) throw new Error("Audio duration and sample count disagree.");
    return { asset, url: body.url, ...(body.duration !== undefined ? { duration: body.duration as number } : {}), ...(body.sampleCount !== undefined ? { sampleCount: body.sampleCount as number, sampleRate: body.sampleRate as number } : {}) };
  } catch (error) {
    throw new Error(`The upload server returned an invalid response: ${error instanceof Error ? error.message : String(error)}`);
  }
}
