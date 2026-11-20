import { app } from "../../scripts/app.js";
import { mountKleinFraming } from "/happylatent/ui/klein-framing.js";

const nodeType = "HappyLatentKleinImage";
const mainFields = { prompt: "Prompt", width: "Width (px)", height: "Height (px)", seed: "Seed" };
const legacyLoaders = [
  { legacy: "diffusion_model", port: "model", type: "MODEL", loader: "UNETLoader", filename: "unet_name", options: { weight_dtype: "default" } },
  { legacy: "text_encoder", port: "clip", type: "CLIP", loader: "CLIPLoader", filename: "clip_name", options: { type: "flux2", device: "default" } },
  { legacy: "vae_name", port: "vae", type: "VAE", loader: "VAELoader", filename: "vae_name", options: {} },
];
const legacyWidgetNames = [
  ...legacyLoaders.map(({ legacy }) => legacy), ...Object.keys(mainFields), "control_after_generate", "reference_framing",
];
const widgetNames = [
  ...Object.keys(mainFields), ...legacyLoaders.map(({ legacy }) => legacy), "reference_framing",
];

function appendLoader(graph, ids, node, input, spec, filename, row) {
  const id = ++ids.node;
  const link = ++ids.link;
  const choices = { [spec.filename]: filename, ...spec.options };
  const widgetInputs = Object.keys(choices).map(name => ({ name, type: "COMBO", link: null, widget: { name } }));
  const pos = node.pos ?? [0, 0];
  graph.nodes.push({
    id, type: spec.loader, pos: [pos[0] - 350, pos[1] + row * 132], size: [300, 70 + 20 * widgetInputs.length],
    flags: {}, order: graph.nodes.length, mode: 0, inputs: widgetInputs,
    outputs: [{ name: spec.type, type: spec.type, links: [link] }],
    properties: { "Node name for S&R": spec.loader },
    widgets_values: Object.values(choices), widgets_values_named: choices,
  });
  input.link = link;
  const slot = node.inputs.indexOf(input);
  graph.links ??= [];
  graph.links.push(graph.version === 1 || graph.state
    ? { id: link, origin_id: id, origin_slot: 0, target_id: node.id, target_slot: slot, type: spec.type }
    : [link, id, 0, node.id, slot, spec.type]);
}

/** Keep existing slot indices while moving old file choices into native loaders. */
function migrateKleinGraph(graph) {
  if (!Array.isArray(graph.nodes)) return;
  const discarded = new Set();
  const linkId = link => Array.isArray(link) ? link[0] : link.id;
  let ids;
  for (const node of graph.nodes.slice()) {
    if (node.type !== nodeType) continue;
    const named = node.widgets_values_named;
    const positional = node.widgets_values;
    const old = Object.hasOwn(named ?? {}, "control_after_generate") || Object.hasOwn(named ?? {}, "count")
      || positional?.length >= legacyWidgetNames.length || node.inputs?.some(input => input.name === "count");
    if (!old) continue;
    const values = Object.fromEntries(legacyWidgetNames.map((name, index) => [name, positional?.[index]]));
    Object.assign(values, named);
    if (typeof values.reference_framing !== "string") values.reference_framing = "{}";

    node.inputs ??= [];
    for (const input of node.inputs) {
      if (!input.widget || !Object.hasOwn(mainFields, input.name)) continue;
      delete input.alwaysVisible;
      if (input.label === mainFields[input.name]) delete input.label;
    }
    const count = node.inputs.find(input => input.name === "count");
    if (count) {
      if (count.link != null) discarded.add(String(count.link));
      Object.assign(count, { name: "reference_framing", type: "STRING", link: null, widget: { name: "reference_framing" } });
      delete count.label;
    }
    const oldOutput = node.outputs?.findIndex(output => output.name === "metadata") ?? -1;
    if (oldOutput >= 0) {
      for (const id of node.outputs[oldOutput].links ?? []) discarded.add(String(id));
      node.outputs.splice(oldOutput, 1);
    }
    for (const [row, spec] of legacyLoaders.entries()) {
      let input = node.inputs.find(input => input.name === spec.port);
      if (!input) {
        input = { name: spec.port, type: spec.type, link: null };
        node.inputs.push(input);
      }
      const legacyInput = node.inputs.find(input => input.name === spec.legacy);
      if (legacyInput?.link != null) continue;
      const filename = values[spec.legacy];
      if (input.link == null && typeof filename === "string" && filename && filename !== "(not installed)") {
        ids ??= {
          node: Math.max(graph.last_node_id ?? 0, graph.state?.lastNodeId ?? 0, ...graph.nodes.map(item => Number(item.id) || 0)),
          link: Math.max(graph.last_link_id ?? 0, graph.state?.lastLinkId ?? 0, ...(graph.links ?? []).map(item => Number(linkId(item)) || 0),
            ...(graph.floatingLinks ?? []).map(item => Number(linkId(item)) || 0)),
        };
        appendLoader(graph, ids, node, input, spec, filename, row);
      }
      values[spec.legacy] = "";
    }
    node.widgets_values_named = Object.fromEntries(widgetNames.filter(name => values[name] !== undefined).map(name => [name, values[name]]));
    node.widgets_values = widgetNames.map(name => values[name] ?? null);
  }
  if (ids && (graph.version === 1 || graph.state)) {
    graph.state ??= { lastGroupId: 0, lastRerouteId: 0 };
    Object.assign(graph.state, { lastNodeId: ids.node, lastLinkId: ids.link });
  } else if (ids) {
    graph.last_node_id = ids.node;
    graph.last_link_id = ids.link;
  }
  if (!discarded.size) return;
  if (Array.isArray(graph.links)) {
    graph.links = graph.links.filter(link => !discarded.has(String(linkId(link))));
  }
  for (const node of graph.nodes) {
    for (const input of node.inputs ?? []) {
      if (discarded.has(String(input.link))) input.link = null;
    }
    for (const output of node.outputs ?? []) {
      if (output.links) output.links = output.links.filter(link => !discarded.has(String(link)));
    }
  }
  for (const output of graph.outputs ?? []) {
    if (output.linkIds) output.linkIds = output.linkIds.filter(link => !discarded.has(String(link)));
  }
}

function loadImagePreview(source) {
  if ((source?.comfyClass ?? source?.type) !== "LoadImage" || source.mode === 2 || source.mode === 4) return {};
  const value = source.widgets?.find(widget => widget.name === "image")?.value;
  if (typeof value !== "string" || !value.trim()) return {};
  const suffix = value.match(/ \[(input|output|temp)\]$/);
  const parts = (suffix ? value.slice(0, suffix.index) : value).split("/");
  const filename = parts.pop();
  if (!filename) return {};
  const params = new URLSearchParams({ filename, subfolder: parts.join("/"), type: suffix?.[1] ?? "input" });
  return { name: filename, url: `/view?${params}` };
}

app.registerExtension({
  name: "HappyLatent.Klein",
  beforeConfigureGraph(graph) {
    migrateKleinGraph(graph);
    for (const subgraph of graph.definitions?.subgraphs ?? []) migrateKleinGraph(subgraph);
  },
  nodeCreated(node) {
    if (node.comfyClass !== nodeType && node.type !== nodeType) return;
    const widget = node.widgets?.find(widget => widget.name === "reference_framing");
    if (!widget) return;
    widget.type = "hidden";
    widget.hidden = true;
    widget.computeSize = () => [0, -4];
    widget.computeLayoutSize = () => ({ minWidth: 0, minHeight: 0, maxHeight: 0 });
    for (const { legacy } of legacyLoaders) {
      const oldWidget = node.widgets.find(input => input.name === legacy);
      if (oldWidget) oldWidget.hidden = true;
    }

    const host = document.createElement("div");
    host.style.cssText = "width:100%;height:100%;overflow:hidden;";
    host.className = "happylatent-klein-widget";
    const shadow = host.attachShadow({ mode: "open" });
    const stylesheet = document.createElement("link");
    stylesheet.rel = "stylesheet";
    stylesheet.href = "/happylatent/ui/styles.css";
    const framingHost = document.createElement("div");
    framingHost.style.cssText = "width:100%;height:100%;min-height:216px;";
    shadow.append(stylesheet, framingHost);
    for (const name of ["pointerdown", "pointerup", "pointermove", "pointercancel", "mousedown", "mouseup", "mousemove",
      "click", "auxclick", "contextmenu", "wheel", "dblclick", "keydown", "keyup", "dragstart", "dragenter", "dragover",
      "dragleave", "drop", "dragend"]) {
      host.addEventListener(name, event => event.stopPropagation());
    }

    let editor;
    let timer;
    let publishing = false;
    function connected(target, index) {
      return target.isInputConnected?.(index) ?? target.inputs?.[index]?.link != null;
    }
    function inputIndex(name) { return node.inputs?.findIndex(input => input.name === name) ?? -1; }
    function isLinked(name) {
      const index = inputIndex(name);
      return index >= 0 && connected(node, index);
    }
    function dimension(name) {
      if (!isLinked(name)) return node.widgets.find(input => input.name === name)?.value;
      const source = node.getInputNode?.(inputIndex(name));
      const kind = source?.comfyClass ?? source?.type;
      if (kind !== "PrimitiveInt" && kind !== "PrimitiveNode") return undefined;
      if (source.mode === 2 || source.mode === 4 || source.inputs?.some((_, index) => connected(source, index))) return undefined;
      return source.widgets?.find(input => input.name === "value")?.value;
    }
    function refresh() { editor?.refresh(); }
    for (const input of node.widgets) {
      if (!["width", "height"].includes(input.name)) continue;
      const nativeCallback = input.callback;
      input.callback = function (...args) {
        const result = nativeCallback?.apply(this, args);
        refresh();
        return result;
      };
    }
    function readFraming() {
      // Older positional saves may restore count as a number in this slot.
      if (typeof widget.value !== "string" || widget.value === "") widget.value = "{}";
      return widget.value;
    }
    const options = {
      getDimensions() {
        const axes = [dimension("width"), dimension("height")];
        if (!axes.every(value => Number.isSafeInteger(value) && value >= 256 && value <= 2048 && value % 32 === 0)) return null;
        return { width: axes[0], height: axes[1] };
      },
      getLinkedSource(slot) {
        const index = node.inputs?.findIndex(input => input.name === slot) ?? -1;
        if (index < 0 || !connected(node, index)) return null;
        return loadImagePreview(node.getInputNode?.(index));
      },
      onChange(value) {
        publishing = true;
        try {
          widget.value = value;
          widget.callback?.(value);
        } finally { publishing = false; }
        node.graph?.change();
        node.setDirtyCanvas(true, true);
      },
    };
    function restore() {
      if (!editor) {
        editor = mountKleinFraming(framingHost, options);
        // Upstream widgets can change without invoking this node's callbacks.
        timer = setInterval(() => { if (host.isConnected) refresh(); }, 750);
      }
      editor.restore(readFraming());
    }
    const callback = widget.callback;
    widget.callback = function (...args) {
      const result = callback?.apply(this, args);
      if (!publishing) restore();
      return result;
    };
    const serializeValue = widget.serializeValue;
    widget.serializeValue = function (...args) {
      const value = readFraming();
      const snapshot = editor?.snapshot(value) ?? value;
      return snapshot !== value ? snapshot : serializeValue ? serializeValue.apply(this, args) : value;
    };
    const serializeNode = node.serialize;
    if (typeof serializeNode === "function") node.serialize = function (...args) {
      const value = readFraming();
      const snapshot = editor?.snapshot(value);
      if (snapshot === undefined || snapshot === value) return serializeNode.apply(this, args);
      const wasPublishing = publishing;
      publishing = true;
      try {
        widget.value = snapshot;
        return serializeNode.apply(this, args);
      } finally {
        try { widget.value = value; }
        finally { publishing = wasPublishing; }
      }
    };

    const panel = node.addDOMWidget("happylatent_klein_framing", "happylatent", host, {
      serialize: false, hideOnZoom: false, hideInPanel: true, getMinHeight: () => 290,
    });
    panel.serialize = false;
    panel.computeLayoutSize = () => ({ minWidth: 430, minHeight: 290 });
    const onConfigure = node.onConfigure;
    node.onConfigure = function (...args) {
      const result = onConfigure?.apply(this, args);
      restore();
      return result;
    };
    const onAdded = node.onAdded;
    node.onAdded = function (...args) {
      const result = onAdded?.apply(this, args);
      if (!editor) restore();
      return result;
    };
    const onConnectionsChange = node.onConnectionsChange;
    node.onConnectionsChange = function (...args) {
      const result = onConnectionsChange?.apply(this, args);
      queueMicrotask(refresh);
      return result;
    };
    const onRemoved = node.onRemoved;
    node.onRemoved = function (...args) {
      clearInterval(timer);
      editor?.dispose();
      editor = undefined;
      return onRemoved?.apply(this, args);
    };
    restore();
    node.setSize([Math.max(520, node.size[0]), Math.max(600, node.size[1])]);
  },
});
