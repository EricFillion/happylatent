import { validateAsset } from "./domain.js";
async function request(url, init) {
    const response = await fetch(url, init);
    if (!response.ok) {
        let message = `${response.status} ${response.statusText}`;
        try {
            const body = await response.json();
            const detail = [body?.error, body?.message].find(value => typeof value === "string" && value.trim());
            if (typeof detail === "string")
                message = detail;
        }
        catch { /* The status remains useful for non-JSON errors. */ }
        throw new Error(message);
    }
    return response.json();
}
export async function uploadAsset(file, kind) {
    const data = new FormData();
    data.append("file", file);
    const result = await request(`/happylatent/assets?kind=${kind}`, { method: "POST", body: data });
    if (!result || typeof result !== "object" || Array.isArray(result))
        throw new Error("The upload server returned an invalid response.");
    const body = result;
    try {
        const asset = validateAsset(body.asset);
        if (typeof body.url !== "string" || !body.url)
            throw new Error("Missing asset URL.");
        if (body.duration !== undefined && (typeof body.duration !== "number" || !Number.isFinite(body.duration) || body.duration < 0))
            throw new Error("Invalid audio duration.");
        for (const key of ["sampleCount", "sampleRate"])
            if (body[key] !== undefined && (typeof body[key] !== "number" || !Number.isSafeInteger(body[key]) || body[key] <= 0))
                throw new Error(`Invalid audio ${key}.`);
        if (kind === "audio" && (body.sampleCount === undefined || body.sampleRate !== 48000))
            throw new Error("Missing normalized 48 kHz audio metadata.");
        if (kind === "audio" && body.sampleCount > 600 * 48000)
            throw new Error("Audio duration cannot exceed 10 minutes.");
        if (kind === "audio" && body.duration !== undefined && Math.abs(body.duration - body.sampleCount / 48000) > 1 / 48000)
            throw new Error("Audio duration and sample count disagree.");
        return { asset, url: body.url, ...(body.duration !== undefined ? { duration: body.duration } : {}), ...(body.sampleCount !== undefined ? { sampleCount: body.sampleCount, sampleRate: body.sampleRate } : {}) };
    }
    catch (error) {
        throw new Error(`The upload server returned an invalid response: ${error instanceof Error ? error.message : String(error)}`);
    }
}
//# sourceMappingURL=api.js.map