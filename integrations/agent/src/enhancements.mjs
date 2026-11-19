// Render options live on HappyLatentVideo, outside the authored project timeline.
export const UPSCALE_MODELS = {
  spatialUpscale: { socket: 'upscale_model', nameInput: 'spatial_upscale_model_name',
    filename: 'ltx-2.5-latent-spatial-upscaler-x2-bf16-1.0.safetensors' },
  temporalUpscale: { socket: 'temporal_upscale_model', nameInput: 'temporal_upscale_model_name',
    filename: 'ltx-2.5-latent-temporal-upscaler-x2-bf16-1.0.safetensors' },
};

export function normalizeEnhancements(value = {}) {
  if (!value || typeof value !== 'object' || Array.isArray(value) ||
      Object.keys(value).some(key => !['spatialUpscale', 'temporalUpscale', 'refine'].includes(key)) ||
      Object.values(value).some(item => typeof item !== 'boolean')) {
    throw new Error('Enhancements must contain only boolean spatialUpscale, temporalUpscale, and refine settings.');
  }
  const spatialUpscale = value.spatialUpscale ?? false;
  const temporalUpscale = value.temporalUpscale ?? false;
  return { spatialUpscale, temporalUpscale, refine: spatialUpscale || temporalUpscale || (value.refine ?? false) };
}

export function hasEnhancements(value) { return value.spatialUpscale || value.temporalUpscale || value.refine; }

export function expectedVideo(project, value) {
  const spatial = value.spatialUpscale ? 2 : 1;
  const temporal = value.temporalUpscale ? 2 : 1;
  return { frames: project.scenes.reduce((sum, scene) => sum + scene.durationFrames, 0) * temporal,
    fps: project.fps * temporal, width: project.width * spatial, height: project.height * spatial };
}

const input = (node, name) => node?.input?.required?.[name] ?? node?.input?.optional?.[name];
const choicesFor = (node, name) => {
  const spec = input(node, name);
  return Array.isArray(spec?.[0]) ? spec[0] : spec?.[0] === 'COMBO' ? spec[1]?.options : undefined;
};

export function enhancementSetup(video, loader, requested) {
  const models = {}, missingNodes = [], missingModels = [], capabilities = {};
  const choices = choicesFor(loader, 'model_name');
  const loaderReady = Array.isArray(choices) && loader?.output?.[0] === 'LATENT_UPSCALE_MODEL';
  const modes = choicesFor(video, 'upscale_mode');
  const enabled = input(video, 'upscale_enabled')?.[0] === 'BOOLEAN';
  const refineSupported = input(video, 'refine_enabled')?.[0] === 'BOOLEAN';
  for (const [key, { socket, filename }] of Object.entries(UPSCALE_MODELS)) {
    const mode = key === 'spatialUpscale' ? 'spatial' : 'temporal';
    const supported = enabled && refineSupported && Array.isArray(modes) && modes.includes(mode) &&
      input(video, socket)?.[0] === 'LATENT_UPSCALE_MODEL' && loaderReady;
    const model = loaderReady ? choices.filter(name => typeof name === 'string' &&
      name.split(/[\\/]/).at(-1) === filename).sort((a, b) => (a === filename ? -1 : b === filename ? 1 : a.localeCompare(b)))[0] : undefined;
    capabilities[key] = { supported, ready: supported && !!model,
      ...(model ? { model } : { requiredModel: filename, directory: 'latent_upscale_models' }) };
    if (!requested[key]) continue;
    if (!supported) missingNodes.push(`HappyLatentVideo/LatentUpscaleModelLoader (${mode} upscaling)`);
    if (model) models[key] = model;
    else if (supported) missingModels.push({ key, dir: 'latent_upscale_models', filenames: [filename] });
  }
  if (requested.spatialUpscale && requested.temporalUpscale && !modes?.includes('spatial+temporal')) {
    missingNodes.push('HappyLatentVideo (combined spatial+temporal mode)');
  }
  capabilities.refine = { supported: refineSupported, ready: refineSupported, additionalModels: false };
  if (requested.refine && !refineSupported) missingNodes.push('HappyLatentVideo (refine_enabled)');
  return { models, missingNodes, missingModels, capabilities };
}

// Add real loader connections so the exported editor exposes the upscale controls.
export function applyEnhancementInputs(api, editor, models, enhancements) {
  if (!hasEnhancements(enhancements)) return;
  const spatial = enhancements.spatialUpscale, temporal = enhancements.temporalUpscale;
  Object.assign(editor.inputs, { upscale_enabled: spatial || temporal,
    upscale_mode: spatial && temporal ? 'spatial+temporal' : temporal ? 'temporal' : 'spatial',
    spatial_upscale_model_name: models.spatialUpscale ?? 'none',
    temporal_upscale_model_name: models.temporalUpscale ?? 'none', refine_enabled: enhancements.refine });
  let nextId = Math.max(...Object.keys(api).map(Number).filter(Number.isFinite), 0) + 1;
  for (const [key, { socket }] of Object.entries(UPSCALE_MODELS)) {
    if (!enhancements[key]) continue;
    if (!models[key]) throw new Error(`The ${key} model must pass setup validation before generating or exporting.`);
    const id = String(nextId++);
    api[id] = { class_type: 'LatentUpscaleModelLoader', inputs: { model_name: models[key] } };
    editor.inputs[socket] = [id, 0];
  }
}

export function applyEnhancementUi(ui, api, enhancements) {
  if (!hasEnhancements(enhancements)) return;
  const editor = ui.nodes.find(node => node.type === 'HappyLatentVideo');
  const values = api[String(editor.id)].inputs;
  const options = [
    ['upscale_enabled', 'BOOLEAN'], ['upscale_model', 'LATENT_UPSCALE_MODEL'],
    ['upscale_mode', 'COMBO'], ['temporal_upscale_model', 'LATENT_UPSCALE_MODEL'],
    ['spatial_upscale_model_name', 'COMBO'], ['temporal_upscale_model_name', 'COMBO'], ['refine_enabled', 'BOOLEAN'],
  ];
  for (const [name, type] of options) {
    const linked = Array.isArray(values[name]);
    const item = { localized_name: name, name, type, shape: 7, link: null,
      ...(type !== 'LATENT_UPSCALE_MODEL' ? { widget: { name } } : {}) };
    const slot = editor.inputs.length;
    editor.inputs.push(item);
    if (type !== 'LATENT_UPSCALE_MODEL') {
      editor.widgets_values_named[name] = values[name];
      editor.widgets_values.push(values[name]);
    }
    if (!linked) continue;
    const sourceId = Number(values[name][0]);
    const linkId = ++ui.last_link_id;
    item.link = linkId;
    ui.links.push([linkId, sourceId, 0, editor.id, slot, 'LATENT_UPSCALE_MODEL']);
    const model = api[String(sourceId)].inputs.model_name;
    ui.nodes.push({ id: sourceId, type: 'LatentUpscaleModelLoader',
      pos: [-100, name === 'upscale_model' ? 800 : 940], size: [340, 82], flags: {}, order: ui.nodes.length,
      mode: 0, inputs: [{ localized_name: 'model_name', name: 'model_name', type: 'COMBO', widget: { name: 'model_name' }, link: null }],
      outputs: [{ localized_name: 'LATENT_UPSCALE_MODEL', name: 'LATENT_UPSCALE_MODEL', type: 'LATENT_UPSCALE_MODEL', links: [linkId] }],
      title: name === 'upscale_model' ? 'Spatial upscale 2×' : 'Temporal upscale 2×',
      properties: { 'Node name for S&R': 'LatentUpscaleModelLoader' },
      widgets_values: [model], widgets_values_named: { model_name: model } });
    ui.last_node_id = Math.max(ui.last_node_id, sourceId);
  }
}
