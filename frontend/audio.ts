import type { Asset, AudioSegment, FileAudioSegment, Project, Scene } from "./domain.js";

export const AUDIO_SAMPLE_RATE = 48000;
export const MAX_SCENE_SECONDS = 20;
export const MAX_SCENES = 100;
// Keep the editable/audio horizon independent of the per-generation limit.
export const MAX_TIMELINE_SECONDS = 6000;
export const MAX_AUDIO_SEGMENTS = 100;

/** Round rational frame boundaries to nearest-even samples, matching Python. */
export function frameToSample(frame: number, fps: number): number {
  const numerator = frame * AUDIO_SAMPLE_RATE;
  const whole = Math.floor(numerator / fps);
  const remainder = numerator - whole * fps;
  return whole + (remainder * 2 > fps || (remainder * 2 === fps && whole % 2 !== 0) ? 1 : 0);
}

export function audioEnd(segment: AudioSegment, projectFrames: number): number {
  return segment.endFrame ?? projectFrames;
}

export type AudioMode = "generated" | "supplied" | "silent";
function sceneRange(project: Project, index: number): [number, number] {
  const start = project.scenes.slice(0, index).reduce((sum, scene) => sum + scene.durationFrames, 0);
  return [start, start + project.scenes[index]!.durationFrames];
}
/** Omitted guidance preserves the behavior of projects saved before this setting. */
export function sceneUsesAudioGuidance(scene: Pick<Scene, "audioGuidance">): boolean {
  return scene.audioGuidance !== false;
}
/** Count uploaded audio once per covered frame, clipped to the scene's bounds. */
export function sceneAudioCoverage(project: Project, index: number): { coveredFrames: number; totalFrames: number } {
  const [start, end] = sceneRange(project, index);
  const ranges = project.audioSegments.filter(segment => segment.kind === "file")
    .map(segment => [Math.max(start, segment.startFrame), Math.min(end, segment.endFrame ?? end)] as const)
    .filter(([first, last]) => last > first)
    .sort((a, b) => a[0] - b[0]);
  let coveredFrames = 0, coveredEnd = start;
  for (const [first, last] of ranges) {
    coveredFrames += Math.max(0, last - Math.max(first, coveredEnd));
    coveredEnd = Math.max(coveredEnd, last);
  }
  return { coveredFrames, totalFrames: end - start };
}
/** Infer old projects without disguising partially generated clips as Generated. */
function inferredSceneAudioMode(project: Project, index: number): AudioMode | "mixed" {
  const [start, end] = sceneRange(project, index);
  const segments = project.audioSegments.filter(segment => segment.startFrame < end && (segment.endFrame ?? Infinity) > start);
  if (!segments.length) return "silent";
  if (segments.every(segment => segment.kind === "file")) return "supplied";
  if (segments.some(segment => segment.kind === "file")) return "mixed";
  let covered = start;
  for (const segment of [...segments].sort((a, b) => a.startFrame - b.startFrame)) {
    if (segment.startFrame > covered) return "mixed";
    covered = Math.max(covered, segment.endFrame ?? end);
  }
  return covered >= end ? "generated" : "mixed";
}
export function sceneAudioMode(project: Project, index: number): AudioMode | "mixed" {
  return project.scenes[index]!.audioMode ?? inferredSceneAudioMode(project, index);
}
/** Saved choices remain visible even when imported content needs repairing. */
export function sceneAudioConflict(project: Project, index: number): boolean {
  const inferred = inferredSceneAudioMode(project, index);
  return inferred === "mixed" || inferred !== sceneAudioMode(project, index);
}
export function audioModeError(index: number): string {
  return `Clip ${index + 1} has conflicting audio. Use one audio type per clip. Select Silent, Provided audio, or Generated audio for the whole clip.`;
}
export function validateGenerationAudio(project: Project): void {
  const index = project.scenes.findIndex((_, index) => sceneAudioConflict(project, index));
  if (index >= 0) throw new Error(audioModeError(index));
}
function clipAudioState(project: Project, index: number): string {
  const [start, end] = sceneRange(project, index);
  return JSON.stringify({ mode: project.scenes[index]!.audioMode, duration: end - start,
    segments: project.audioSegments.filter(segment => segment.startFrame < end && (segment.endFrame ?? Infinity) > start).map(segment => ({
      kind: segment.kind, start: Math.max(0, segment.startFrame - start), end: Math.min(end, segment.endFrame ?? end) - start,
      ...(segment.kind === "file" ? { asset: segment.asset, offset: segment.sourceOffsetSamples + frameToSample(Math.max(start, segment.startFrame), project.fps) - frameToSample(segment.startFrame, project.fps) } : {}),
    })),
  });
}
/** Unrelated edits can preserve imported conflicts, but edits cannot create new ones. */
export function validateAudioModeEdit(next: Project, previous: Project): Project {
  const index = next.scenes.findIndex((scene, index) => {
    if (!sceneAudioConflict(next, index)) return false;
    const prior = previous.scenes.findIndex(row => row.id === scene.id);
    return prior < 0 || !sceneAudioConflict(previous, prior) || clipAudioState(next, index) !== clipAudioState(previous, prior);
  });
  if (index >= 0) throw new Error(audioModeError(index));
  return next;
}
/** Stable draft IDs keep drag previews and the eventual undo entry identical. */
function stableAudioId(seed: string, used: Set<string>): string {
  let hash = 2166136261;
  for (let index = 0; index < seed.length; index++) hash = Math.imul(hash ^ seed.charCodeAt(index), 16777619);
  const base = `audio-${(hash >>> 0).toString(16)}-${seed.length}`;
  let id = base, suffix = 1;
  while (used.has(id)) id = `${base}-${suffix++}`;
  used.add(id);
  return id;
}
/** Remove only the requested range, retaining adjacent media and exact source phase. */
function clearAudioRange(segments: AudioSegment[], start: number, end: number, fps: number, projectFrames: number, kind?: AudioSegment["kind"]): AudioSegment[] {
  const ids = new Set(segments.map(segment => segment.id));
  return segments.flatMap(segment => {
    const priorEnd = segment.endFrame ?? Infinity;
    if (kind && segment.kind !== kind || priorEnd <= start || segment.startFrame >= end) return [segment];
    const result: AudioSegment[] = [];
    if (segment.startFrame < start) result.push({ ...segment, endFrame: start });
    if (priorEnd > end && (segment.endFrame !== null || end < projectFrames)) {
      const right = { ...segment, id: result.length ? stableAudioId(`${segment.id}:after:${end}`, ids) : segment.id, startFrame: end };
      if (right.kind === "file") right.sourceOffsetSamples += frameToSample(end, fps) - frameToSample(segment.startFrame, fps);
      result.push(right);
    }
    return result;
  });
}
export function setSceneAudioMode(project: Project, index: number, mode: AudioMode): Project {
  const [start, end] = sceneRange(project, index);
  if (sceneAudioMode(project, index) === mode && !sceneAudioConflict(project, index)) {
    if (project.scenes[index]!.audioMode === mode && (mode === "supplied" || project.scenes[index]!.audioFallbackMode === undefined)) return project;
    return { ...project, scenes: project.scenes.map((scene, i) => i === index ? audioChoice(scene, mode, rememberedAudioFallback(project, index)) : scene) };
  }
  let segments = clearAudioRange(project.audioSegments, start, end, project.fps, project.scenes.reduce((sum, scene) => sum + scene.durationFrames, 0), mode === "supplied" ? "generate" : undefined);
  if (mode === "generated") segments = [...segments, { id: stableAudioId(`generated:${project.scenes[index]!.id}`, new Set(segments.map(segment => segment.id))), kind: "generate" as const, startFrame: start, endFrame: end }].sort((a, b) => a.startFrame - b.startFrame);
  return { ...project, scenes: project.scenes.map((scene, i) => i === index ? audioChoice(scene, mode, rememberedAudioFallback(project, index)) : scene), audioSegments: segments };
}
function audioChoice(scene: Scene, mode: AudioMode, fallback?: "generated" | "silent"): Scene {
  const { audioFallbackMode: _, ...rest } = scene;
  return { ...rest, audioMode: mode, ...(mode === "supplied" && fallback ? { audioFallbackMode: fallback } : {}) };
}
function rememberedAudioFallback(project: Project, index: number): "generated" | "silent" | undefined {
  const mode = sceneAudioMode(project, index);
  if (mode === "generated" || mode === "silent") return mode;
  return project.scenes[index]!.audioFallbackMode;
}
function priorAudioFallback(project: Project, index: number): "generated" | "silent" {
  return rememberedAudioFallback(project, index) ?? "silent";
}
function intersects(segment: AudioSegment, start: number, end: number): boolean {
  return segment.startFrame < end && (segment.endFrame ?? Infinity) > start;
}
function assertProvidedAudioDoesNotOverlap(segments: AudioSegment[]): void {
  const files = segments.filter(segment => segment.kind === "file").sort((a, b) => a.startFrame - b.startFrame);
  for (let index = 1; index < files.length; index++) {
    if ((files[index - 1]!.endFrame ?? Infinity) > files[index]!.startFrame) {
      throw new Error("Provided audio overlaps another audio block. Move it to a free range or replace that block explicitly.");
    }
  }
}
/** Reconcile changed file coverage in one history edit, leaving unrelated legacy conflicts alone. */
export function reconcileProvidedAudio(next: Project, previous: Project): Project {
  assertProvidedAudioDoesNotOverlap(next.audioSegments);
  const files = next.audioSegments.filter((segment): segment is FileAudioSegment => segment.kind === "file");
  const oldFiles = previous.audioSegments.filter(segment => segment.kind === "file");
  const placement = (segment?: FileAudioSegment): string | undefined => {
    if (!segment) return undefined;
    const { name: _, ...audio } = segment;
    return JSON.stringify(audio);
  };
  const changedIds = new Set([...files, ...oldFiles].filter(segment =>
    placement(files.find(row => row.id === segment.id)) !== placement(oldFiles.find(row => row.id === segment.id))).map(segment => segment.id));
  if (!changedIds.size) return next;
  const changed = [...files, ...oldFiles].filter(segment => changedIds.has(segment.id));
  const total = next.scenes.reduce((sum, scene) => sum + scene.durationFrames, 0);
  let segments = [...next.audioSegments];
  // Files beyond the last scene still replace generated ranges, without moving
  // their source or assigning a mode to a scene they do not touch.
  for (const file of files.filter(file => changedIds.has(file.id))) {
    segments = clearAudioRange(segments, file.startFrame, file.endFrame ?? Infinity, next.fps, total, "generate");
  }
  const scenes = next.scenes.map((scene, index) => {
    const [start, end] = sceneRange(next, index);
    if (!changed.some(segment => intersects(segment, start, end))) return scene;
    const prior = previous.scenes.findIndex(row => row.id === scene.id);
    const fallback = prior < 0 ? (scene.audioFallbackMode ?? (scene.audioMode === "generated" ? "generated" : "silent")) : priorAudioFallback(previous, prior);
    const mode = files.some(segment => intersects(segment, start, end)) ? "supplied" : fallback;
    segments = clearAudioRange(segments, start, end, next.fps, total, "generate");
    if (mode === "generated") segments.push({ id: stableAudioId(`generated:${scene.id}`, new Set(segments.map(segment => segment.id))), kind: "generate", startFrame: start, endFrame: end });
    // Legacy provided clips already express the right choice through their
    // files. Preserve that saved shape while coverage remains provided.
    if (mode === "supplied" && prior >= 0 && sceneAudioMode(previous, prior) === "supplied") return scene;
    return audioChoice(scene, mode, prior < 0 ? fallback : rememberedAudioFallback(previous, prior));
  });
  return { ...next, scenes, audioSegments: segments.sort((a, b) => a.startFrame - b.startFrame) };
}
/** Upsert one continuous file; replacing a different file always remains explicit. */
export function placeProvidedAudio(project: Project, incoming: FileAudioSegment): Project {
  return reconcileProvidedAudio({ ...project, audioSegments: [...project.audioSegments.filter(segment => segment.id !== incoming.id), incoming].sort((a, b) => a.startFrame - b.startFrame) }, project);
}
/** Uploading audio explicitly chooses Supplied for every clip it touches. */
export function supplyAudioToClips(project: Project, incoming: AudioSegment): Project {
  let next = project;
  project.scenes.forEach((_, index) => {
    const [start, end] = sceneRange(project, index);
    if (incoming.startFrame < end && (incoming.endFrame ?? Infinity) > start) next = setSceneAudioMode(next, index, "supplied");
  });
  return next;
}

/** Uploaded files stay on the timeline; generated choices follow their scenes. */
export function reflowSceneAudio(next: Project, previous: Project): Project {
  const timing = (project: Project) => project.scenes.map(scene => [scene.id, scene.durationFrames]);
  if (next.fps !== previous.fps || JSON.stringify(timing(next)) === JSON.stringify(timing(previous)) || JSON.stringify(next.audioSegments) !== JSON.stringify(previous.audioSegments)) return next;
  const oldTotal = previous.scenes.reduce((sum, scene) => sum + scene.durationFrames, 0);
  const newTotal = next.scenes.reduce((sum, scene) => sum + scene.durationFrames, 0);
  const defaultMode = previous.scenes.every((_, index) => sceneAudioMode(previous, index) === "silent" && !sceneAudioConflict(previous, index)) ? "silent" : "generated";
  const files = previous.audioSegments.filter((segment): segment is FileAudioSegment => segment.kind === "file");
  const segments: AudioSegment[] = [...files], ids = new Set(files.map(segment => segment.id));
  const append = (segment: AudioSegment): void => {
    const id = ids.has(segment.id) ? stableAudioId(`${segment.id}:${segment.startFrame}:${segment.endFrame}`, ids) : segment.id;
    ids.add(id);
    segments.push({ ...segment, id });
  };
  const scenes = next.scenes.map((scene, index) => {
    const [start, end] = sceneRange(next, index);
    const oldIndex = previous.scenes.findIndex(row => row.id === scene.id);
    const oldMode = scene.audioMode ?? (oldIndex < 0 ? defaultMode : sceneAudioMode(previous, oldIndex));
    // Imported conflicts keep their content until the user explicitly chooses a mode.
    const preserveConflict = oldIndex >= 0 && sceneAudioConflict(previous, oldIndex);
    const fallback = oldIndex < 0 ? (oldMode === "generated" ? "generated" : "silent") : priorAudioFallback(previous, oldIndex);
    const covered = files.some(file => intersects(file, start, end));
    const mode = covered ? "supplied" : oldMode === "supplied" ? fallback : oldMode;
    if (mode === "generated" && !preserveConflict) {
      const prior = oldIndex < 0 ? undefined : previous.audioSegments.find(segment => segment.kind === "generate" && segment.startFrame < sceneRange(previous, oldIndex)[1] && (segment.endFrame ?? Infinity) > sceneRange(previous, oldIndex)[0]);
      append({ id: prior?.id ?? stableAudioId(`generated:${scene.id}`, new Set(ids)), kind: "generate", startFrame: start, endFrame: end });
    } else if (preserveConflict) {
      const [oldStart, oldEnd] = sceneRange(previous, oldIndex);
      for (const segment of previous.audioSegments) {
        if (segment.kind === "file" || segment.startFrame >= oldEnd || (segment.endFrame ?? Infinity) <= oldStart) continue;
        const sourceStart = Math.max(oldStart, segment.startFrame);
        const movedStart = start + sourceStart - oldStart;
        const movedEnd = Math.min(end, start + Math.min(oldEnd, segment.endFrame ?? oldEnd) - oldStart);
        if (movedStart >= movedEnd) continue;
        append({ ...segment, startFrame: movedStart, endFrame: movedEnd });
      }
    }
    const keepLegacyShape = oldIndex >= 0 && mode === oldMode && (scene.audioMode === undefined || mode === "supplied");
    return mode === "mixed" || preserveConflict || keepLegacyShape ? scene : audioChoice(scene, mode, oldIndex < 0 ? fallback : rememberedAudioFallback(previous, oldIndex));
  });
  // Future generated blocks retain their distance beyond the video. Uploaded
  // files, including future portions, were retained intact above.
  for (const segment of previous.audioSegments) {
    if (segment.kind === "file") continue;
    if (segment.startFrame < oldTotal && (segment.endFrame === null || segment.endFrame <= oldTotal)) continue;
    const sourceStart = Math.max(oldTotal, segment.startFrame);
    append({ ...segment, startFrame: newTotal + sourceStart - oldTotal,
      endFrame: segment.endFrame === null ? null : newTotal + segment.endFrame - oldTotal,
    });
  }
  let reflowed = segments;
  for (const file of files) {
    if ((file.endFrame ?? Infinity) <= newTotal) continue;
    reflowed = clearAudioRange(reflowed, Math.max(file.startFrame, newTotal), file.endFrame ?? Infinity, next.fps, newTotal, "generate");
  }
  return { ...next, scenes, audioSegments: reflowed.sort((a, b) => a.startFrame - b.startFrame) };
}

/** Last whole timeline frame whose samples fit the remaining uploaded source. */
export function fileAudioEndLimit(segment: FileAudioSegment, projectFrames: number, fps: number, sourceDurationSeconds?: number): number {
  if (sourceDurationSeconds === undefined || !Number.isFinite(sourceDurationSeconds)) return audioEnd(segment, projectFrames);
  const remaining = Math.max(0, Math.floor(sourceDurationSeconds * AUDIO_SAMPLE_RATE + 1e-6) - segment.sourceOffsetSamples);
  const firstSample = frameToSample(segment.startFrame, fps);
  let lower = segment.startFrame, upper = Math.max(lower, fps * MAX_TIMELINE_SECONDS);
  while (lower < upper) {
    const middle = Math.ceil((lower + upper) / 2);
    if (frameToSample(middle, fps) - firstSample <= remaining) lower = middle; else upper = middle - 1;
  }
  return lower;
}

function integer(value: unknown, name: string, maximum: number): number {
  if (!Number.isSafeInteger(value) || (value as number) < 0 || (value as number) > maximum) {
    throw new Error(`${name} must be an integer from 0 to ${maximum}.`);
  }
  return value === 0 ? 0 : value as number;
}

export function validateAudioSegments(value: unknown, fps: number, asset: (value: unknown) => Asset): AudioSegment[] {
  if (!Array.isArray(value) || value.length > MAX_AUDIO_SEGMENTS) {
    throw new Error(`Audio segments must be a list of at most ${MAX_AUDIO_SEGMENTS} blocks.`);
  }
  const ids = new Set<string>();
  const segments = value.map((raw): AudioSegment => {
    if (!raw || typeof raw !== "object" || Array.isArray(raw)) throw new Error("Audio segment must be an object.");
    const row = raw as Record<string, unknown>;
    if (typeof row.id !== "string" || !row.id.trim() || row.id.length > 128 || ids.has(row.id)) {
      throw new Error("Audio segment IDs must be nonempty and unique.");
    }
    ids.add(row.id);
    if (row.kind !== "generate" && row.kind !== "file") throw new Error("Unsupported audio segment type.");
    if (typeof row.startFrame === "number" && row.startFrame > fps * MAX_TIMELINE_SECONDS || typeof row.endFrame === "number" && row.endFrame > fps * MAX_TIMELINE_SECONDS) throw new Error("Audio must stay within the supported timeline range.");
    const startFrame = integer(row.startFrame, "Audio start", fps * MAX_TIMELINE_SECONDS);
    const endFrame = row.endFrame === null ? null : integer(row.endFrame, "Audio end", fps * MAX_TIMELINE_SECONDS);
    if (endFrame !== null && endFrame <= startFrame) throw new Error("Audio end must be after its start.");
    const base = { id: row.id, startFrame, endFrame };
    if (row.kind === "generate") {
      if (Object.hasOwn(row, "asset") || Object.hasOwn(row, "sourceOffsetSamples")) throw new Error("Generated audio cannot contain a source file.");
      return { ...base, kind: "generate" };
    }
    if (row.name !== undefined && (typeof row.name !== "string" || row.name.length > 255)) throw new Error("Audio name must be text of at most 255 characters.");
    return { ...base, kind: "file", asset: asset(row.asset),
      sourceOffsetSamples: integer(row.sourceOffsetSamples, "Audio source start", AUDIO_SAMPLE_RATE * 600),
      ...(typeof row.name === "string" && row.name.trim() ? { name: row.name.trim() } : {}),
    };
  }).sort((a, b) => a.startFrame - b.startFrame);
  for (let i = 1; i < segments.length; i++) {
    const prior = segments[i - 1]!;
    if (prior.endFrame === null || prior.endFrame > segments[i]!.startFrame) throw new Error("Audio segments cannot overlap; only the last block can follow video end.");
  }
  return segments;
}

/** Insert one authored range, preserving outside fragments without a hidden bed. */
export function insertAudioSegment(segments: AudioSegment[], incoming: AudioSegment, projectFrames: number, fps: number): AudioSegment[] {
  const start = incoming.startFrame;
  const end = incoming.endFrame ?? Infinity;
  const result: AudioSegment[] = [];
  for (const segment of segments) {
    const priorEnd = segment.endFrame ?? Infinity;
    if (priorEnd <= start || segment.startFrame >= end) { result.push(structuredClone(segment)); continue; }
    if (segment.startFrame < start) result.push({ ...structuredClone(segment), endFrame: start });
    if (priorEnd > end && (segment.endFrame !== null || end < projectFrames || segment.startFrame >= projectFrames)) {
      const right = { ...structuredClone(segment), id: segment.startFrame < start ? crypto.randomUUID() : segment.id, startFrame: end };
      if (right.kind === "file") right.sourceOffsetSamples = Math.min(AUDIO_SAMPLE_RATE * 600,
        right.sourceOffsetSamples + frameToSample(end, fps) - frameToSample(segment.startFrame, fps));
      result.push(right);
    }
  }
  result.push(structuredClone(incoming));
  return result.sort((a, b) => a.startFrame - b.startFrame);
}

/** Move only the selected clip to the nearest free range, keeping its visible length. */
export function moveAudioSegment(segments: AudioSegment[], sourceId: string, requestedStart: number, projectFrames: number, fps: number): AudioSegment[] {
  const source = segments.find(segment => segment.id === sourceId);
  if (!source || !Number.isFinite(requestedStart) || !Number.isSafeInteger(fps) || fps <= 0 || !Number.isSafeInteger(projectFrames) || projectFrames < 0) return segments;
  const maximum = fps * MAX_TIMELINE_SECONDS;
  const visibleEnd = (segment: AudioSegment): number => Math.min(maximum, segment.endFrame ?? (segment.startFrame >= projectFrames ? segment.startFrame + fps : projectFrames));
  const duration = visibleEnd(source) - source.startFrame;
  if (!Number.isSafeInteger(source.startFrame) || source.startFrame < 0 || source.startFrame > maximum || !Number.isSafeInteger(duration) || duration < 1 || duration > maximum) return segments;
  const requested = Math.round(requestedStart), peers = segments.filter(segment => segment.id !== sourceId).sort((a, b) => a.startFrame - b.startFrame);
  let nearest: number | undefined, distance = Infinity, lower = 0;
  const considerGap = (upper: number): void => {
    upper = Math.min(maximum, upper);
    if (upper - lower < duration) return;
    const candidate = Math.max(lower, Math.min(upper - duration, requested)), difference = Math.abs(candidate - requested);
    // Gaps are visited chronologically, so equal distances consistently choose the earlier one.
    if (difference < distance) { nearest = candidate; distance = difference; }
  };
  for (const peer of peers) { considerGap(peer.startFrame); lower = Math.max(lower, visibleEnd(peer)); }
  considerGap(maximum);
  if (nearest === undefined || nearest === source.startFrame) return segments;
  const result = [...peers, { ...source, startFrame: nearest, endFrame: nearest + duration }].sort((a, b) => a.startFrame - b.startFrame);
  // A following-end block can only be last. Fixing its current endpoint leaves its visible range intact.
  return result.map((segment, index) => segment.endFrame === null && index < result.length - 1 ? { ...segment, endFrame: visibleEnd(segment) } : segment);
}

export function fileSegments(segments: AudioSegment[]): FileAudioSegment[] {
  return segments.filter((segment): segment is FileAudioSegment => segment.kind === "file");
}
