import { z } from 'zod/v4';
import { memoryEntry } from './memory.mjs';
import { assembleScenePrompt } from '../resources/project-core/domain.js';

const bindingSchema = z.strictObject({
  characters: z.array(memoryEntry).max(8),
  location: memoryEntry.optional(),
  notes: z.string().max(8000).optional(),
}).superRefine((binding, ctx) => {
  if (binding.characters.some(entry => entry.kind !== 'character')) ctx.addIssue({ code: 'custom', message: 'Characters must reference character memories.' });
  if (binding.location && binding.location.kind !== 'location') ctx.addIssue({ code: 'custom', message: 'Location must reference a location memory.' });
  if (new Set(binding.characters.map(entry => entry.memoryId)).size !== binding.characters.length) ctx.addIssue({ code: 'custom', message: 'A character can be assigned only once per scene.' });
});

export function validateSceneMemory(project, value = {}) {
  if (!value || typeof value !== 'object' || Array.isArray(value) || Object.keys(value).length > 100) throw new Error('Scene memory must be a map of at most 100 scene assignments.');
  const result = Object.fromEntries(Object.entries(value).map(([id, binding]) => [
    z.string().min(1).max(128).parse(id), bindingSchema.parse(binding),
  ]));
  const ids = new Set(project.scenes.map(scene => scene.id));
  for (const sceneId of Object.keys(result)) if (!ids.has(sceneId)) throw new Error(`Scene ${sceneId} is not in this project.`);
  return result;
}

function scenePrompt(scene, memory) {
  if (!memory) return scene.prompt;
  const descriptions = [
    ...memory.characters.map(entry => `Character ${entry.name}: ${entry.description}`),
    ...(memory.location ? [`Location ${memory.location.name}: ${memory.location.description}`] : []),
  ];
  return [scene.prompt, ...descriptions].filter(Boolean).join('\n\n');
}

// Memory lives in the MCP project envelope. Flatten descriptions only at the
// renderer boundary so existing ComfyUI project schemas and exports stay valid.
export function projectWithMemory(snapshot) {
  const bindings = validateSceneMemory(snapshot.project, snapshot.sceneMemory);
  if (!Object.keys(bindings).length) return snapshot.project;
  return { ...snapshot.project, scenes: snapshot.project.scenes.map(scene => ({
    ...scene, prompt: scenePrompt(scene, Object.hasOwn(bindings, scene.id) ? bindings[scene.id] : undefined),
  })) };
}

export function sceneContext(snapshot, sceneId) {
  const project = projectWithMemory(snapshot);
  const scene = project.scenes.find(scene => scene.id === sceneId);
  if (!scene) throw new Error(`Scene ${sceneId} is not in this project.`);
  return { sceneId, memory: (Object.hasOwn(snapshot.sceneMemory ?? {}, sceneId) ? snapshot.sceneMemory[sceneId] : { characters: [] }),
    effectivePrompt: assembleScenePrompt(project, scene) };
}

export async function resolveCharacterSpeech(memory, { character, ...request }) {
  if (!character) {
    if (!request.speaker) throw new Error('Supply a speaker or a character memory with a pinned revision.');
    return request;
  }
  if (!Number.isSafeInteger(character.revision) || character.revision < 1) throw new Error('Pin a character memory revision for repeatable speech requests.');
  const entry = await memory.get(character);
  if (entry.kind !== 'character') throw new Error('Speech requires a character memory.');
  const speaker = request.speaker ?? entry.voice?.speaker;
  if (!speaker) throw new Error('This character has no saved voice. Save a voice or supply speaker explicitly.');
  return { ...request, speaker, speed: request.speed ?? entry.voice?.speed ?? 1 };
}
