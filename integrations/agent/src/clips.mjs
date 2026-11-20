// Planning is shared by validation, job identity and expected-result reporting.
// The backend receives the original project so scene seeds and audio offsets stay stable.
export function renderPlan(project, { mode = 'generate', sceneIds } = {}) {
  if (sceneIds !== undefined && mode === 'generate') mode = 'selected';
  if (!['generate', 'selected', 'export'].includes(mode)) throw new Error('Render mode must be generate, selected, or export.');
  if (mode !== 'selected' && sceneIds?.length) throw new Error('sceneIds are only valid for selected generation.');
  const selected = mode === 'selected' ? sceneIds : [];
  if (mode === 'selected' && (!Array.isArray(selected) || !selected.length || new Set(selected).size !== selected.length ||
      selected.some(id => !project.scenes.some(scene => scene.id === id)))) {
    throw new Error('Selected generation requires unique sceneIds belonging to this project.');
  }
  const generated = project.scenes.filter(scene => mode === 'selected' ? selected.includes(scene.id) : mode === 'generate' && !scene.video);
  if (mode === 'export' && project.scenes.some(scene => !scene.video)) throw new Error('Choose an existing take for every scene before exporting the video.');
  const scope = mode === 'selected' && project.scenes.some(scene => !selected.includes(scene.id) && !scene.video) ? 'selection' : 'project';
  const scenes = scope === 'selection' ? project.scenes.filter(scene => selected.includes(scene.id)) : project.scenes;
  return { mode, sceneIds: selected, scope, generated, scenes, needsModels: generated.length > 0 };
}

export function videoTake(raw) {
  const asset = raw?.asset;
  const parts = typeof asset?.subfolder === 'string' ? asset.subfolder.split('/') : [];
  if (!raw || typeof raw.id !== 'string' || !/^[a-zA-Z0-9_-]{1,128}$/.test(raw.id) ||
      !asset || !['input', 'output'].includes(asset.type) || typeof asset.filename !== 'string' ||
      !asset.filename || asset.filename.length > 255 || !asset.filename.toLowerCase().endsWith('.mp4') || /[\\/\x00-\x1f]/.test(asset.filename) || ['.', '..'].includes(asset.filename) ||
      !parts.length || parts[0] !== 'happylatent' || parts.some(part => !part || part === '.' || part === '..' || /[\\\x00-\x1f]/.test(part)) ||
      !Number.isSafeInteger(raw.frameCount) || raw.frameCount < 1 || raw.frameCount > 72000 || !Number.isFinite(raw.fps) || raw.fps < 1 || raw.fps > 120 || raw.frameCount > raw.fps * 600 + 1e-7 ||
      !Number.isSafeInteger(raw.width) || raw.width < 1 || raw.width > 8192 ||
      !Number.isSafeInteger(raw.height) || raw.height < 1 || raw.height > 8192 || typeof raw.hasAudio !== 'boolean') {
    throw new Error('The backend returned an invalid video take.');
  }
  const take = { id: raw.id, asset: { filename: asset.filename, subfolder: asset.subfolder, type: asset.type },
    frameCount: raw.frameCount, fps: raw.fps, width: raw.width, height: raw.height, hasAudio: raw.hasAudio };
  for (const [key, max] of [['name', 120], ['createdAt', 64], ['projectId', 128], ['sceneId', 128]]) {
    if (raw[key] === undefined) continue;
    if (typeof raw[key] !== 'string' || raw[key].length > max) throw new Error('The backend returned invalid video take metadata.');
    take[key] = raw[key];
  }
  return take;
}

export function clipManifest(raw, job) {
  if (!raw || raw.runId !== job.id || raw.projectId !== job.projectId || !['project', 'selection'].includes(raw.scope) || !Array.isArray(raw.clips)) {
    throw new Error('The backend returned a mismatched clip manifest.');
  }
  return { runId: raw.runId, projectId: raw.projectId, scope: raw.scope, clips: raw.clips.map(videoTake), ...(typeof raw.complete === 'boolean' ? { complete: raw.complete } : {}) };
}

export function assemblyWorkflow(project, prefix, options) {
  return {
    '5': { class_type: 'HappyLatentVideo', inputs: { project: JSON.stringify(project),
      render_mode: options.mode, scene_ids: JSON.stringify(options.sceneIds), run_id: options.runId ?? '' } },
    '6': { class_type: 'SaveVideo', inputs: { video: ['5', 0], filename_prefix: prefix, format: 'mp4', 'format.codec': 'auto' } },
  };
}

export function renderUi(ui, api) {
  const keptIds = new Set(Object.keys(api).map(Number));
  ui.nodes = ui.nodes.filter(node => keptIds.has(node.id));
  ui.links = ui.links.filter(link => keptIds.has(link[1]) && keptIds.has(link[3]));
  const editor = ui.nodes.find(node => node.type === 'HappyLatentVideo');
  const inputs = api[String(editor.id)].inputs;
  editor.inputs = editor.inputs.filter(input => !['model', 'clip', 'video_vae', 'audio_vae'].includes(input.name) || inputs[input.name]);
  for (const [name, type] of [['render_mode', 'COMBO'], ['scene_ids', 'STRING'], ['run_id', 'STRING']]) {
    if (!Object.hasOwn(inputs, name)) continue;
    const names = Object.keys(editor.widgets_values_named);
    const existing = names.indexOf(name);
    editor.widgets_values_named[name] = inputs[name];
    if (existing === -1) editor.widgets_values.push(inputs[name]);
    else editor.widgets_values[existing] = inputs[name];
    if (!editor.inputs.some(input => input.name === name)) editor.inputs.push({ name, type, link: null, widget: { name } });
  }
}
