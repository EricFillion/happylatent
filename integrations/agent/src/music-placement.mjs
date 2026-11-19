import { createHash } from 'node:crypto';
import { z } from 'zod/v4';
import { musicSecondsToSamples, readProject, validateAsset, validateMusicSegments } from '../resources/project-core/domain.js';
import { frameToSample } from '../resources/project-core/audio.js';

const frame = z.number().int().nonnegative().max(360000);
const asset = z.strictObject({
  filename: z.string().min(1).max(255), subfolder: z.string().max(255).optional(),
  type: z.literal('input').optional(),
});

export const musicPlacementRequest = z.strictObject({
  asset,
  scope: z.enum(['full_video', 'ranges', 'scenes']).default('full_video'),
  ranges: z.array(z.strictObject({ startFrame: frame, endFrame: frame })).min(1).max(100).optional(),
  sceneIds: z.array(z.string().min(1).max(128)).min(1).max(100).optional(),
  profile: z.enum(['start', 'high_energy', 'low_energy', 'build']).default('start'),
  sourceStartSeconds: z.number().min(0).max(600).optional(),
  gainDb: z.number().min(-60).max(6).default(-12),
  fadeInSeconds: z.number().min(0).max(30).optional(),
  fadeOutSeconds: z.number().min(0).max(30).optional(),
  name: z.string().max(255).optional(),
});

function finite(value, name, min, max) {
  if (typeof value !== 'number' || !Number.isFinite(value) || value < min || value > max) {
    throw new Error(`${name} must be a finite number from ${min} to ${max}.`);
  }
  return value;
}

function targetRanges(project, request) {
  const total = project.scenes.reduce((sum, scene) => sum + scene.durationFrames, 0);
  let ranges;
  if (request.scope === 'full_video') {
    if (request.ranges || request.sceneIds) throw new Error('Full-video music does not accept ranges or scene IDs.');
    ranges = [{ startFrame: 0, endFrame: total }];
  } else if (request.scope === 'ranges') {
    if (!request.ranges || request.sceneIds) throw new Error('Range music requires ranges and no scene IDs.');
    ranges = request.ranges;
  } else {
    if (!request.sceneIds || request.ranges) throw new Error('Scene music requires scene IDs and no ranges.');
    const selected = new Set(request.sceneIds);
    if (selected.size !== request.sceneIds.length) throw new Error('Selected scene IDs must be unique.');
    let cursor = 0;
    ranges = [];
    for (const scene of project.scenes) {
      if (selected.delete(scene.id)) ranges.push({ startFrame: cursor, endFrame: cursor + scene.durationFrames });
      cursor += scene.durationFrames;
    }
    if (selected.size) throw new Error('A selected scene is not in this project.');
  }
  const result = [];
  for (const range of [...ranges].sort((a, b) => a.startFrame - b.startFrame)) {
    if (range.endFrame <= range.startFrame || range.endFrame > total) {
      throw new Error('Music ranges must have positive duration and stay inside this video.');
    }
    const previous = result.at(-1);
    if (previous && range.startFrame < previous.endFrame) throw new Error('Music target ranges cannot overlap.');
    // Adjacent selected scenes share one continuous piece of music.
    if (previous && range.startFrame === previous.endFrame) previous.endFrame = range.endFrame;
    else result.push({ ...range });
  }
  return result;
}

function analysisData(analysis) {
  if (!analysis || typeof analysis !== 'object') throw new Error('Analyze the actual audio before planning music placement.');
  const duration = finite(analysis.durationSeconds, 'Measured music duration', Number.MIN_VALUE, 600);
  const range = analysis.analyzedRange ?? { startSeconds: 0, endSeconds: duration };
  const start = finite(range.startSeconds, 'Analyzed start', 0, duration);
  const end = finite(range.endSeconds, 'Analyzed end', start, duration);
  const beats = (Array.isArray(analysis.beatsSeconds) ? analysis.beatsSeconds : [])
    .filter(value => typeof value === 'number' && Number.isFinite(value) && value >= start && value <= end)
    .slice(0, 20000).sort((a, b) => a - b);
  const energy = (Array.isArray(analysis.energy) ? analysis.energy : [])
    .filter(value => value && Number.isFinite(value.timeSeconds) && Number.isFinite(value.relative)
      && value.timeSeconds >= start && value.timeSeconds <= end && value.relative >= 0 && value.relative <= 1)
    .slice(0, 20000).sort((a, b) => a.timeSeconds - b.timeSeconds);
  const prefix = [0];
  for (const point of energy) prefix.push(prefix.at(-1) + point.relative);
  return { duration, start, end, beats, energy, prefix };
}

function lowerBound(points, time) {
  let low = 0, high = points.length;
  while (low < high) {
    const middle = (low + high) >>> 1;
    if (points[middle].timeSeconds < time) low = middle + 1;
    else high = middle;
  }
  return low;
}

function meanEnergy(data, start, end) {
  const first = lowerBound(data.energy, start), last = lowerBound(data.energy, end);
  return last > first ? (data.prefix[last] - data.prefix[first]) / (last - first) : null;
}

function windowMetrics(data, start, duration) {
  const end = start + duration, width = Math.min(duration / 3, 5);
  const early = meanEnergy(data, start, start + width), late = meanEnergy(data, end - width, end);
  let low = 0, high = data.beats.length;
  while (low < high) {
    const middle = (low + high) >>> 1;
    if (data.beats[middle] < start) low = middle + 1;
    else high = middle;
  }
  const beatAligned = Math.abs((data.beats[low] ?? Infinity) - start) <= 0.05
    || Math.abs((data.beats[low - 1] ?? Infinity) - start) <= 0.05;
  return { meanRelativeEnergy: meanEnergy(data, start, end),
    energyChange: early === null || late === null ? null : late - early,
    beatAligned };
}

function chooseWindow(analysis, data, request, duration) {
  const available = (musicSecondsToSamples(data.duration) - musicSecondsToSamples(request.sourceStartSeconds ?? 0)) / 48000;
  if (duration > available + 1e-9) {
    throw new Error(`This placement needs ${duration.toFixed(3)} seconds of music but only ${available.toFixed(3)} seconds are available. Generate a longer track, choose another source range, or shorten the placement. Music is never silently looped or padded.`);
  }
  if (request.sourceStartSeconds !== undefined || request.profile === 'start') {
    const start = musicSecondsToSamples(request.sourceStartSeconds ?? 0) / 48000;
    return { start, ...windowMetrics(data, start, duration), selection: request.sourceStartSeconds !== undefined ? 'explicit_source' : 'source_start' };
  }
  if (analysis.silent === true) {
    throw new Error('The analyzed recording is silent; there is insufficient audible material to select an energy profile. Choose an explicit source range or generate/import another track.');
  }
  if (data.end - data.start < duration - 1 / 48000 || !data.energy.length) {
    throw new Error('Analyze a long enough source range with energy measurements before selecting this music profile.');
  }
  const latest = data.end - duration;
  const starts = new Set([data.start, latest]);
  for (const beat of data.beats) if (beat <= latest) starts.add(beat);
  for (const section of (Array.isArray(analysis.sections) ? analysis.sections : []).slice(0, 2000)) if (section && Number.isFinite(section.startSeconds)
    && section.startSeconds >= data.start && section.startSeconds <= latest) starts.add(section.startSeconds);
  for (const window of (Array.isArray(analysis.candidateWindows) ? analysis.candidateWindows : []).slice(0, 2000)) if (window && Number.isFinite(window.startSeconds)
    && window.startSeconds >= data.start && window.startSeconds <= latest) starts.add(window.startSeconds);
  // A regular grid also works for ambient tracks that have no reliable beat.
  const step = Math.max(0.25, (latest - data.start) / 1000);
  for (let time = data.start; time < latest; time += step) starts.add(time);
  let selected;
  for (const rawStart of starts) {
    const start = musicSecondsToSamples(rawStart) / 48000;
    if (musicSecondsToSamples(start) + musicSecondsToSamples(duration) > musicSecondsToSamples(data.duration)) continue;
    const metrics = windowMetrics(data, start, duration);
    if (metrics.meanRelativeEnergy === null) continue;
    const score = request.profile === 'high_energy' ? metrics.meanRelativeEnergy
      : request.profile === 'low_energy' ? -metrics.meanRelativeEnergy : metrics.energyChange;
    if (score === null) continue;
    // The musical feature dominates; a near-tie prefers a measured beat.
    const value = score + (metrics.beatAligned ? 0.005 : 0);
    if (!selected || value > selected.value + 1e-9
      || Math.abs(value - selected.value) < 1e-9 && start < selected.start) {
      selected = { start, ...metrics, value, selection: 'measured_energy' };
    }
  }
  if (!selected) throw new Error('There are insufficient energy measurements for a suitable music window.');
  return selected;
}

/** Return a reviewable, deterministic edit plan. Does not mutate or render. */
export function planMusicPlacement(rawProject, rawRequest, analysis) {
  const project = readProject(rawProject);
  const request = musicPlacementRequest.parse(rawRequest);
  const source = validateAsset(request.asset);
  const data = analysisData(analysis);
  const ranges = targetRanges(project, request);
  const rationale = [];
  const placements = ranges.map(range => {
    const samples = frameToSample(range.endFrame, project.fps) - frameToSample(range.startFrame, project.fps);
    const duration = samples / 48000;
    const selected = chooseWindow(analysis, data, request, duration);
    const id = 'music-' + createHash('sha256').update(JSON.stringify([project.id, source, range])).digest('hex').slice(0, 24);
    const placement = { id, asset: source, ...range, sourceStartSeconds: selected.start,
      audioDurationSeconds: data.duration, gainDb: request.gainDb,
      fadeInSeconds: request.fadeInSeconds ?? Math.min(0.25, Math.floor(samples / 2) / 48000),
      fadeOutSeconds: request.fadeOutSeconds ?? Math.min(0.5, Math.floor(samples / 2) / 48000),
      ...(request.name !== undefined ? { name: request.name } : {}) };
    rationale.push({ musicId: id, profile: request.profile, selection: selected.selection,
      sourceStartSeconds: selected.start, sourceEndSeconds: selected.start + duration,
      meanRelativeEnergy: selected.meanRelativeEnergy, energyChange: selected.energyChange,
      beatAligned: selected.beatAligned,
      note: 'Energy and beat alignment are signal-derived estimates. They do not establish mood, a chorus, vocals, or a musical drop.' });
    return placement;
  });
  const validated = validateMusicSegments(placements, project.fps);
  return { scope: request.scope, profile: request.profile, fps: project.fps,
    placements: validated, rationale, preservesSceneAudio: true, loops: false,
    operations: validated.map(({ id, ...placement }) => ({ op: 'place_music', musicId: id, ...placement })) };
}
