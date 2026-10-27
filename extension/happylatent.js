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
      return serializeProject ? serializeProject.apply(this, args) : this.value;
    };
    // Workflow saving copies widget.value directly, bypassing serializeValue.
    // Flush before the native serializer captures its widget values and hooks.
    // Autosave can run during a pointer gesture; capture its draft without ending it.
    const serializeNode = node.serialize;
    if (typeof serializeNode === "function") node.serialize = function (...args) {
      const snapshot = editor?.flushPendingEdits(false);
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
      restore();
      return result;
    };
    const onAdded = node.onAdded;
    node.onAdded = function (...args) {
      const result = onAdded?.apply(this, args);
      if (!editor) restore();
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
