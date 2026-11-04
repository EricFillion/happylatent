import { app } from "../../scripts/app.js";
import { api } from "../../scripts/api.js";
import { mountHappyLatentVideo } from "/happylatent/ui/app.js";
import { newProject, readProject } from "/happylatent/ui/domain.js";
import { watchModelProfile } from "/happylatent/ui/model-profile.js";
import { createGenerationTracker, executionNode } from "/happylatent/ui/generation-status.js";

const NODE_TYPES = new Set(["HappyLatentVideo"]);
const DEFAULT_TITLES = new Set(["HappyLatentVideo"]);
const generation = createGenerationTracker(api, id => executionNode(app.rootGraph ?? app.graph, id));

/** The ordinary STRING widget remains the workflow/API value; the DOM widget only edits it. */
app.registerExtension({
  name: "HappyLatent.Video",
  nodeCreated(node) {
    if (!NODE_TYPES.has(node.comfyClass) && !NODE_TYPES.has(node.type)) return;
    function updateTitle() { if (!node.title || DEFAULT_TITLES.has(node.title)) node.title = "HappyLatentVideo"; }
    updateTitle();
    const projectWidget = node.widgets?.find(widget => widget.name === "project");
    if (!projectWidget) throw new Error("HappyLatentVideo is missing its project input.");
    projectWidget.type = "hidden";
    projectWidget.hidden = true;
    projectWidget.computeSize = () => [0, -4];
    projectWidget.computeLayoutSize = () => ({ minWidth: 0, minHeight: 0, maxHeight: 0 });

    // Native widgets remain the workflow/API persistence boundary. Only connected
    // model inputs expose the corresponding controls in the editor.
    const upscaleNames = ["upscale_enabled", "upscale_mode", "spatial_upscale_model_name", "temporal_upscale_model_name", "refine_enabled"];
    const upscaleWidgets = Object.fromEntries(upscaleNames.map(name => [name, node.widgets?.find(widget => widget.name === name)]));
    const hasUpscaleControls = Boolean(upscaleWidgets.upscale_enabled && upscaleWidgets.upscale_mode);
    let publishingUpscale = false;
    function linked(name) { return node.inputs?.some(input => input.name === name && input.link != null) ?? false; }
    function modelLinked(name) { return node.inputs?.some(input => input.name === name && input.type === "LATENT_UPSCALE_MODEL" && input.link != null) ?? false; }
    function upscaleSettings() {
      if (!hasUpscaleControls) return undefined;
      const enabled = upscaleWidgets.upscale_enabled.value === true;
      const mode = upscaleWidgets.upscale_mode.value;
      const spatialLinked = modelLinked("upscale_model"), temporalLinked = modelLinked("temporal_upscale_model");
      return {
        spatialEnabled: spatialLinked && enabled && (mode === "spatial" || mode === "spatial+temporal"),
        temporalEnabled: temporalLinked && enabled && (mode === "temporal" || mode === "spatial+temporal"),
        spatialLinked,
        temporalLinked,
        controlsLinked: linked("upscale_enabled") || linked("upscale_mode"),
        refineEnabled: upscaleWidgets.refine_enabled?.value === true,
        refineLinked: linked("refine_enabled"),
      };
    }
    function persistUpscale(spatialEnabled, temporalEnabled) {
      const changes = {
        upscale_enabled: spatialEnabled || temporalEnabled,
        upscale_mode: spatialEnabled && temporalEnabled ? "spatial+temporal" : temporalEnabled ? "temporal" : "spatial",
      };
      publishingUpscale = true;
      try {
        for (const [name, next] of Object.entries(changes)) {
          const widget = upscaleWidgets[name];
          if (widget.value !== next) { widget.value = next; widget.callback?.(next); }
        }
      } finally { publishingUpscale = false; }
    }
    function syncUpscale(normalize = false) {
      const settings = upscaleSettings();
      if (settings) {
        // Clear disconnected stages before saving or queueing, including legacy
        // workflows whose hidden filename selections used to enable upscaling.
        if (normalize) persistUpscale(settings.spatialEnabled, settings.temporalEnabled);
        editor?.setUpscaleSettings(settings);
      }
      for (const input of node.inputs ?? []) {
        if (input.name === "upscale_model") input.label = "spatial_upscaler";
        if (input.name === "temporal_upscale_model") input.label = "temporal_upscaler";
      }
    }
    function changeUpscale(value) {
      const current = upscaleSettings();
      if (!current) return;
      if (current.controlsLinked && (current.refineLinked || current.temporalEnabled || !upscaleWidgets.refine_enabled || typeof value.refineEnabled !== "boolean" || current.refineEnabled === value.refineEnabled)) return;
      if (!current.controlsLinked) persistUpscale(Boolean(current.spatialLinked && value.spatialEnabled), Boolean(current.temporalLinked && value.temporalEnabled));
      const refine = upscaleWidgets.refine_enabled;
      // The widget retains the manual preference; temporal refinement is forced
      // by the backend and displayed as checked without overwriting that choice.
      if (refine && !current.refineLinked && !current.temporalEnabled && typeof value.refineEnabled === "boolean" && refine.value !== value.refineEnabled) {
        refine.value = value.refineEnabled;
        refine.callback?.(refine.value);
      }
      syncUpscale();
      node.graph?.change();
      node.setDirtyCanvas(true, true);
    }
    if (hasUpscaleControls) for (const widget of Object.values(upscaleWidgets).filter(Boolean)) {
      widget.type = "hidden";
      widget.hidden = true;
      widget.computeSize = () => [0, -4];
      widget.computeLayoutSize = () => ({ minWidth: 0, minHeight: 0, maxHeight: 0 });
      const callback = widget.callback;
      widget.callback = function (...args) {
        const result = callback?.apply(this, args);
        if (!publishingUpscale) syncUpscale();
        return result;
      };
    }

    const host = document.createElement("div");
    host.className = "happylatent-widget";
    host.style.cssText = "width:100%;height:100%;overflow:hidden;";
    const shadow = host.attachShadow({ mode: "open" });
    const stylesheet = document.createElement("link");
    stylesheet.rel = "stylesheet";
    stylesheet.href = "/happylatent/ui/styles.css";
    const container = document.createElement("div");
    container.style.cssText = "width:100%;height:100%;";
    shadow.append(stylesheet, container);
    // Keep both pointer events and their compatibility mouse events inside the
    // widget. Older canvas handlers still listen for mouse/click/contextmenu.
    // Do not prevent default: inputs retain selection, native menus and scrolling.
    for (const name of ["pointerdown", "pointerup", "pointermove", "pointercancel",
      "mousedown", "mouseup", "mousemove", "click", "auxclick", "contextmenu", "wheel", "dblclick", "keydown", "keyup",
      "dragstart", "dragenter", "dragover", "dragleave", "drop", "dragend"]) {
      host.addEventListener(name, event => event.stopPropagation());
    }
    let editor;
    let stopModelProfile;
    let stopGeneration;
    let publishing = false;
    const widgetCallback = projectWidget.callback;
    // API imports assign widget.value after nodeCreated/onAdded, then call its
    // callback without onConfigure. Restore that late external value as well.
    projectWidget.callback = function (...args) {
      const result = widgetCallback?.apply(this, args);
      if (!publishing) restore();
      return result;
    };
    const serializeProject = projectWidget.serializeValue;
    projectWidget.serializeValue = function (...args) {
      // ComfyUI must never queue an older value while an editor field is invalid.
      editor?.flushPendingEdits();
      syncUpscale(true);
      return serializeProject ? serializeProject.apply(this, args) : this.value;
    };
    // Workflow saving copies widget.value directly, bypassing serializeValue.
    // Flush before the native serializer captures its widget values and hooks.
    // Autosave can run during a pointer gesture; capture its draft without ending it.
    const serializeNode = node.serialize;
    if (typeof serializeNode === "function") node.serialize = function (...args) {
      const snapshot = editor?.flushPendingEdits(false);
      syncUpscale(true);
      const value = projectWidget.value;
      const wasPublishing = publishing;
      publishing = true;
      try {
        if (snapshot) projectWidget.value = JSON.stringify(snapshot);
        return serializeNode.apply(this, args);
      } finally {
        try { projectWidget.value = value; }
        finally { publishing = wasPublishing; }
      }
    };
    function restore() {
      stopGeneration?.(); stopGeneration = undefined;
      try {
        const raw = projectWidget.value;
        const parsed = raw ? JSON.parse(raw) : undefined;
        const project = raw ? readProject(parsed) : newProject();
        if (!raw || parsed?.version !== project.version) projectWidget.value = JSON.stringify(project);
        if (editor) editor.setProject(project);
        else {
          container.replaceChildren();
          stopModelProfile?.();
          editor = mountHappyLatentVideo(container, {
            project,
            upscale: upscaleSettings(),
            onUpscaleChange: changeUpscale,
            onChange(value) {
              publishing = true;
              try {
                projectWidget.value = JSON.stringify(value);
                projectWidget.callback?.(projectWidget.value);
              } finally { publishing = false; }
              node.graph?.change();
              node.setDirtyCanvas(true, true);
            },
          });
          stopModelProfile = watchModelProfile(node, profile => editor?.setModelProfile(profile));
        }
        syncUpscale();
        stopGeneration = generation.watch(node, status => editor?.setGenerationStatus(status));
      } catch (error) {
        stopModelProfile?.(); stopModelProfile = undefined;
        editor?.dispose(); editor = undefined;
        const message = document.createElement("p");
        message.style.cssText = "padding:16px;color:#f0b6bf;font:13px system-ui;";
        message.textContent = `Project could not be loaded: ${error instanceof Error ? error.message : String(error)}`;
        container.replaceChildren(message);
      }
    }
    const widget = node.addDOMWidget("happylatent_editor", "happylatent", host, {
      serialize: false,
      hideOnZoom: false,
      // The properties panel's legacy canvas fallback overwrites this DOM widget's width.
      hideInPanel: true,
      getMinHeight: () => 700,
    });
    widget.serialize = false;
    widget.computeLayoutSize = () => ({ minWidth: 820, minHeight: 700 });
    const onConfigure = node.onConfigure;
    node.onConfigure = function (...args) {
      const result = onConfigure?.apply(this, args);
      updateTitle();
      const config = args[0], refine = upscaleWidgets.refine_enabled;
      if (refine && config && typeof config === "object" && (config.widgets_values_named || Array.isArray(config.widgets_values))) {
        const named = config.widgets_values_named;
        const hasRefine = named && Object.hasOwn(named, "refine_enabled")
          || Array.isArray(config.widgets_values) && typeof config.widgets_values[node.widgets.indexOf(refine)] === "boolean";
        if (!hasRefine) refine.value = upscaleSettings()?.spatialEnabled === true;
      }
      syncUpscale(true);
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
      // Connecting several inputs during import may happen in sequence; keep
      // the saved mode until configuration/serialization has all the inputs.
      syncUpscale(args[2] !== true);
      return result;
    };
    const onRemoved = node.onRemoved;
    node.onRemoved = function (...args) {
      stopModelProfile?.(); stopModelProfile = undefined;
      stopGeneration?.(); stopGeneration = undefined;
      editor?.dispose(); editor = undefined;
      return onRemoved?.apply(this, args);
    };
    restore();
    // Start near square, with wider prompt fields and a usable reference preview.
    // Saved workflows still restore their own node dimensions in onConfigure.
    node.setSize([1200, Math.max(1180, node.size[1])]);
  },
});
