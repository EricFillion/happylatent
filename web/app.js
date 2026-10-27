import { assetUrl, createScene, durationFramesFromSeconds, formatDuration, formatPlaybackTime, formatTime, getSampling, getImageStrength, minSceneFrames, MAX_SCENE_PROMPT_LENGTH, History, MAX_SCENE_NAME_LENGTH, newProject, sceneAtFrame, sceneName, sceneStartFrame, totalFrames, validateProject, readProject, validateProjectEdit, SAMPLING_PRESETS } from "./domain.js";
import { uploadAsset } from "./api.js";
import { Playback } from "./playback.js";
import { Timeline } from "./timeline.js";
import { MAX_SCENE_SECONDS, MAX_TIMELINE_SECONDS, audioEnd, fileAudioEndLimit, placeProvidedAudio, reconcileProvidedAudio, sceneAudioMode, sceneAudioConflict, sceneAudioCoverage, sceneUsesAudioGuidance, reflowSceneAudio, setSceneAudioMode, validateGenerationAudio, validateAudioModeEdit, audioModeError } from "./audio.js";
import { positionedCrop } from "./crop.js";
import { bindCropDrag } from "./crop-drag.js";
import { bindPanelSplit } from "./panel-split.js";
const icon = (name) => ({ play: "▶", pause: "Ⅱ", image: "▧", plus: "+", audio: "♫", undo: "↶", redo: "↷" }[name] ?? name);
/** Each mounted editor owns its state. ComfyUI's project widget is the persistence boundary. */
export function mountHappyLatentVideo(container, options = {}) {
    const root = document.createElement("div");
    root.className = "happylatent";
    root.dataset.testid = "app";
    container.append(root);
    const editorId = `happylatent-${crypto.randomUUID()}`;
    root.innerHTML = `
    <div class="generation-status" data-testid="generation-status" role="status" aria-live="polite" aria-atomic="true" hidden><span class="generation-activity" aria-hidden="true" hidden></span><span class="generation-status-text"></span></div>
    <header class="happylatent-header">
      <div class="preset-control"><span class="preset-label" id="${editorId}-mode-label">Generation mode</span><details class="editor-menu generation-menu"><summary class="sampling-preset" data-testid="sampling-preset" aria-label="Generation mode" aria-haspopup="menu" aria-describedby="${editorId}-sampling-summary"><span class="preset-value"></span></summary><div class="menu-options" role="menu" aria-labelledby="${editorId}-mode-label"><button role="menuitemradio" aria-checked="false" data-action="set-preset" data-preset="auto">Auto</button><button role="menuitemradio" aria-checked="false" data-action="set-preset" data-preset="distilled">Distilled</button><button role="menuitemradio" aria-checked="false" data-action="set-preset" data-preset="full">Full</button></div></details><span class="sampling-summary" id="${editorId}-sampling-summary" data-testid="sampling-summary" role="status"></span></div>
      <div class="header-actions"><button class="icon-button" data-action="undo" title="Undo (⌘/Ctrl Z)" aria-label="Undo">↶</button><button class="icon-button" data-action="redo" title="Redo (⌘/Ctrl Shift Z)" aria-label="Redo">↷</button></div>
      <p class="inline-feedback project-feedback" data-testid="project-feedback" role="alert" hidden></p>
    </header>
    <section class="global-settings" aria-label="Global settings">
      <div class="global-settings-main">
        <label class="field-label global-prompt-field"><span class="global-prompt-label">Global prompt<span class="section-scope">All clips</span></span><textarea class="global-prompt" data-testid="global-prompt" aria-label="Global prompt" maxlength="16000" rows="2"></textarea></label>
        <div class="settings-grid global-settings-grid"><label>Width (px)<input class="width" type="number" min="64" max="4096" step="32" aria-label="Output width"></label><label>Height (px)<input class="height" type="number" min="64" max="4096" step="32" aria-label="Output height"></label><label title="Frames per second, shared by all clips">Frame rate<input class="fps" type="number" min="1" max="60" step="1" aria-label="Frame rate"></label><label>Seed<input class="seed" type="number" min="0" max="9007199254740991" step="1" aria-label="Seed"></label></div>
      </div>
      <p class="inline-feedback settings-feedback" data-testid="settings-feedback" id="${editorId}-settings-feedback" role="alert" hidden></p>
    </section>
    <p class="inline-feedback audio-mode-feedback" data-testid="audio-mode-feedback" role="alert" hidden></p>
    <p class="inline-feedback scene-limit-feedback" data-testid="scene-limit-feedback" role="alert" hidden></p>
    <section class="inspector" aria-label="Selected clip settings">
      <section class="inspector-section scene-inspector" aria-label="Clip settings">
        <div class="section-heading"><strong class="selected-scene-heading" data-testid="selected-scene-heading"></strong></div>
        <div class="scene-fields">
          <label class="field-label scene-prompt-field">Clip prompt<textarea class="scene-prompt" data-testid="scene-prompt" aria-label="Clip prompt" maxlength="${MAX_SCENE_PROMPT_LENGTH}" rows="2"></textarea></label>
          <div class="scene-controls"><div class="scene-timing"><label class="duration-row"><span>Duration (s)</span><span class="number-unit"><input class="scene-duration" data-testid="scene-duration" type="number" min="0.042" max="${MAX_SCENE_SECONDS}" step="0.042" aria-label="Clip duration in seconds" aria-describedby="${editorId}-scene-timing"><span class="duration-stepper"><button type="button" data-duration-step="scene-up" aria-label="Increase clip duration by one frame" title="Increase by one frame" tabindex="-1">▴</button><button type="button" data-duration-step="scene-down" aria-label="Decrease clip duration by one frame" title="Decrease by one frame" tabindex="-1">▾</button></span></span></label><p class="frame-help" id="${editorId}-scene-timing"></p></div>
          </div>
        </div>

        <p class="inline-feedback scene-feedback" data-testid="scene-feedback" id="${editorId}-scene-feedback" role="alert" hidden></p>
      </section>
      <section class="inspector-section audio-inspector" data-testid="audio-inspector" aria-label="Audio segment settings" hidden>
        <div class="section-heading"><strong>Audio</strong><span class="section-scope">Selected audio</span><button class="quiet-button audio-apply-button" data-action="open-audio-range" data-testid="audio-apply-clips">Apply to clips…</button></div>
        <div class="audio-layout">
          <div class="audio-summary">
            <div class="audio-title-line"><div class="audio-heading"></div></div>
            <div class="audio-description">
              <p class="audio-generation-help">Generated audio covers the whole clip and uses its prompt. Select the clip to change its duration or audio mode.</p>
              <div class="audio-file-details"><p class="audio-source-duration"></p><button class="quiet-button" data-action="replace-audio">Replace file</button><button class="quiet-button" data-action="audio" data-testid="add-audio">Upload audio</button></div>
            </div>
          </div>
          <div class="audio-fields">
            <div class="audio-file-fields"><label class="duration-row"><span>Source start (s)</span><span class="number-unit"><input class="audio-trim" type="number" min="0" max="600" step="0.000020833333333333333" aria-label="Audio source start in seconds"></span></label></div>
            <div class="audio-timing"><label class="duration-row"><span>Duration (s)</span><span class="number-unit"><input class="audio-duration" type="number" min="0.042" max="${MAX_TIMELINE_SECONDS}" aria-label="Audio duration in seconds" aria-describedby="${editorId}-audio-start-time"><span class="duration-stepper"><button type="button" data-duration-step="audio-up" aria-label="Increase audio duration by one frame" title="Increase by one frame" tabindex="-1">▴</button><button type="button" data-duration-step="audio-down" aria-label="Decrease audio duration by one frame" title="Decrease by one frame" tabindex="-1">▾</button></span></span></label><p class="audio-start-time" id="${editorId}-audio-start-time"></p></div>
          </div>
        </div>
        <p class="audio-empty-help">Add generated audio or upload a file at the playhead.</p><p class="inline-feedback audio-edit-feedback" data-testid="audio-edit-feedback" role="alert" hidden></p>
      </section>
    </section>
    <dialog class="audio-apply-dialog" aria-labelledby="${editorId}-audio-apply-title">
      <h2 id="${editorId}-audio-apply-title">Apply audio to selected clips</h2>
      <p>One continuous recording will cover this range. Every clip in the range will use Provided audio.</p>
      <div class="audio-apply-selects"><label>From clip<select class="audio-apply-start" data-testid="audio-apply-start" aria-label="From clip"></select></label><label>Through clip<select class="audio-apply-end" data-testid="audio-apply-end" aria-label="Through clip"></select></label></div>
      <p class="audio-apply-help">Uses the current source start. Audio stays at its original speed.</p>
      <p class="inline-feedback audio-apply-error" data-testid="audio-apply-error" role="alert" hidden></p>
      <div class="audio-apply-actions"><button class="quiet-button" data-action="cancel-audio-range">Cancel</button><button class="add-clip" data-action="apply-audio-range" data-testid="apply-audio-range">Apply</button></div>
    </dialog>
    <div class="happylatent-workspace">
      <main class="happylatent-main" aria-label="Clip images">
        <section class="keyframe-editor" aria-label="Images"><div class="image-panel-heading"><strong>Images</strong><span class="preview-scene-name" data-testid="preview-scene-name"></span></div><div class="keyframe-strip" data-testid="keyframe-strip"></div><span class="preview-frame-label"></span></section>
        <div class="preview-stage" data-testid="preview">
          <img class="preview-image" alt="Clip reference" draggable="false" hidden><div class="preview-crop-overlay" data-testid="preview-crop-overlay" hidden><div class="preview-crop-frame" data-testid="preview-crop-frame" role="group" aria-label="Image crop. Drag or use arrow keys to move the area used in the video." title="Drag to move; drag a corner to resize"><button type="button" class="crop-handle" data-crop-handle="nw" aria-label="Resize crop top left"></button><button type="button" class="crop-handle" data-crop-handle="ne" aria-label="Resize crop top right"></button><button type="button" class="crop-handle" data-crop-handle="sw" aria-label="Resize crop bottom left"></button><button type="button" class="crop-handle" data-crop-handle="se" aria-label="Resize crop bottom right"></button></div></div>
          <span class="crop-area-label" data-testid="crop-area-label" hidden>Area used in the video</span>
          <input type="file" class="visually-hidden" data-testid="preview-image-input" accept="image/png,image/jpeg,image/webp">
        </div>
        <div class="image-controls" data-testid="image-controls" aria-label="Selected image"><section class="scene-settings" data-testid="scene-settings" aria-label="Image guidance">
            <div class="strength-scope-field"><span>Apply to</span><details class="editor-menu strength-scope-menu"><summary class="strength-scope" data-testid="apply-sampling-all" aria-label="Apply image strength" aria-haspopup="menu" aria-describedby="${editorId}-strength-scope-value"><span class="strength-scope-value" id="${editorId}-strength-scope-value"></span><span aria-hidden="true">⌄</span></summary><div class="menu-options" role="menu" aria-label="Image strength scope"><button role="menuitemradio" aria-checked="true" data-action="set-strength-scope" data-strength-scope="image">This image</button><button role="menuitemradio" aria-checked="false" data-action="set-strength-scope" data-strength-scope="scene">Images in this clip</button><button role="menuitemradio" aria-checked="false" data-action="set-strength-scope" data-strength-scope="all">Images in all clips</button></div></details></div>
            <div class="settings-grid scene-sampling-grid"><label class="image-strength-field" data-testid="image-strength-field"><span class="image-strength-label">Strength</span><input class="image-strength" data-testid="image-strength" type="number" min="0" max="1" step="0.05" aria-label="Image strength"></label></div>
            <div class="sampling-footer"><button class="text-button" data-action="reset-sampling" aria-label="Use clip default" title="Use each image’s clip default for the selected scope">Default</button></div>
          </section><div class="preview-image-actions"><button class="quiet-button" data-action="reset-crop" data-testid="reset-crop">Reset crop</button><button class="quiet-button" data-action="preview-image" data-testid="replace-preview-image">Replace</button><button class="quiet-button" data-action="remove-image" data-testid="remove-preview-image">Remove</button></div></div>
        <p class="inline-feedback image-feedback" data-testid="image-feedback" role="alert" hidden></p>

      </main>
    </div>
        <div class="panel-divider" data-testid="panel-divider" role="separator" tabindex="0" aria-label="Resize preview and timeline" aria-orientation="horizontal" aria-controls="${editorId}-timeline" title="Drag to resize preview and timeline. Arrow keys adjust; Enter or double-click resets."><span aria-hidden="true"></span></div>
        <section class="timeline-panel" id="${editorId}-timeline" aria-label="Timeline editor">
          <div class="timeline-actions"><span class="video-duration" data-testid="video-duration" title="Seconds are rounded to one decimal; exact timing is preserved."></span><button class="add-clip" data-action="add-scene" data-testid="add-scene" aria-label="Add clip">+ Add clip</button><div class="clip-audio-control"><span class="audio-mode-label">Audio</span><details class="editor-menu add-audio-menu"><summary class="add-clip" aria-label="Clip audio mode" title="Choose one audio mode for the selected clip" aria-haspopup="menu"><span class="clip-audio-value"></span> <span aria-hidden="true">⌄</span></summary><div class="menu-options" role="menu" aria-label="Clip audio choices"><button role="menuitemradio" aria-checked="false" data-action="add-generated-audio" data-testid="add-generated-audio" data-audio-mode="generated">Generate audio</button><button role="menuitemradio" aria-checked="false" data-action="set-supplied-audio" data-testid="supplied-audio" data-audio-mode="supplied">Provide audio</button><button role="menuitemradio" aria-checked="false" data-action="silent-audio" data-testid="silent-audio" data-audio-mode="silent">Silent</button></div></details></div>
          <details class="editor-menu audio-guidance-menu"><summary class="audio-guidance-summary" data-testid="audio-guidance-menu" aria-label="Clip audio guidance"><span class="audio-guidance-value">Audio guidance</span><span class="audio-coverage-value"></span></summary><div class="menu-options audio-guidance-options">
          <div class="scene-audio-guidance" role="group" aria-labelledby="${editorId}-audio-guidance-scope">
            <div class="audio-guidance-control"><span class="audio-guidance-scope" data-testid="audio-guidance-scope" id="${editorId}-audio-guidance-scope"></span><button class="audio-guidance-label audio-guidance" data-testid="audio-guidance" type="button" role="checkbox" aria-checked="true"><span class="audio-guidance-check" aria-hidden="true"></span>Use audio to guide video</button><p class="audio-guidance-description" id="${editorId}-audio-guidance-description"></p></div>
            <div class="audio-coverage-details"><p class="audio-coverage" data-testid="audio-coverage"></p><div class="audio-coverage-bar" aria-hidden="true"></div><p class="audio-guidance-help" data-testid="audio-guidance-help" id="${editorId}-audio-guidance-help"></p></div>
          </div></div></details></div>
          <div class="transport"><button class="icon-button" data-action="start" aria-label="Go to start" title="Go to start">|◀</button><button class="play-button" data-action="play" data-testid="play-toggle" aria-label="Play">▶</button><span class="playhead-time" data-testid="playhead-time">0:00.0</span><span class="total-time" data-testid="total-duration" aria-label="Total duration"></span><span class="timecode-format" title="Playback position and duration are shown as minutes:seconds.tenths"></span></div>
          <div class="timeline-toolbar"><button class="quiet-button" data-action="audio" data-testid="upload-timeline-audio">Upload audio</button><div class="timeline-zoom" role="group" aria-label="Timeline zoom controls"><button class="quiet-button" data-action="timeline-zoom-out" aria-label="Zoom out timeline" title="Zoom out">−</button><input class="timeline-zoom-range" type="range" min="-2" max="5" step="0.25" value="0" aria-label="Timeline zoom" aria-valuetext="100%"><button class="quiet-button" data-action="timeline-zoom-in" aria-label="Zoom in timeline" title="Zoom in">+</button><output class="timeline-zoom-value" aria-hidden="true">100%</output><button class="quiet-button" data-action="timeline-fit" aria-label="Fit timeline" title="Show all clips and audio">Fit</button></div></div>
          <div class="timeline-surface"><canvas class="timeline-canvas" data-testid="timeline" tabindex="0" role="slider" aria-label="Timeline position in frames" aria-valuemin="0" aria-valuenow="0"></canvas><input class="scene-name-input" data-testid="scene-name-input" aria-label="Clip name" maxlength="${MAX_SCENE_NAME_LENGTH}" hidden></div>
          <div class="timeline-scroll" data-testid="timeline-scroll" tabindex="0" role="region" aria-label="Scroll audio and video timeline"><div class="timeline-scroll-space"></div></div>
          <input type="file" class="visually-hidden" data-testid="audio-input" accept="audio/*"><input type="file" class="visually-hidden" data-testid="scene-image-input" accept="image/png,image/jpeg,image/webp">
          <p class="inline-feedback audio-feedback" data-testid="audio-feedback" role="alert" hidden></p>
          <p class="audio-drag-preview" data-testid="audio-drag-preview" role="status" aria-live="polite" aria-atomic="true" hidden></p>
          <p class="inline-feedback playback-feedback" data-testid="playback-feedback" role="alert" hidden></p>

        </section>
`;
    function q(selector) { const element = root.querySelector(selector); if (!element)
        throw new Error(`Missing editor element: ${selector}`); return element; }
    let project = readProject(options.project ?? newProject());
    const validateEdit = (next) => {
        const parsed = validateProjectEdit(next, project);
        const reflowed = reflowSceneAudio(parsed, project);
        return validateAudioModeEdit(reflowed === parsed ? parsed : validateProjectEdit(reflowed, project), project);
    };
    let history = new History(project);
    let modelProfile = { preset: null, reason: "Connect a supported model, or choose Distilled or Full." };
    let selectedId = project.scenes[0].id;
    let mode = "image";
    let selectedAudioId = project.audioSegments[0]?.id ?? "";
    let audioRevision = 0;
    let transportRequest = 0;
    let audioDraft;
    let audioRangeTarget;
    let renamingId;
    let renameDraft = "";
    let frame = 0;
    let disposed = false;
    let previewFrame = "first";
    let strengthScope = "image";
    let strengthTarget = "";
    const previewSlots = new Map();
    let previewSceneId = "";
    let lastPreviewImage = "";
    let previewImageState = "empty";
    let cropSignature = "";
    let lastAudioAsset = "";
    let audioLoading = false;
    let audioUploading = false;
    let audioError = "";
    let audioErrorSource = "other";
    const imageFeedback = new Map();
    const numericInputs = [];
    const numericValues = new Map();
    let cropDraft;
    let audioLoadVersion = 0;
    let audioUploadVersion = 0;
    const imageUploadVersions = new Map();
    let projectEpoch = 0;
    let renderedSceneId;
    const pendingImageAdds = new Map();
    let previewImageTarget;
    let sceneImageTarget;
    let audioChooserTarget;
    const abort = new AbortController();
    const events = { signal: abort.signal };
    const playback = new Playback(project);
    const timeline = new Timeline(q(".timeline-canvas"), project, q(".timeline-scroll"));
    timeline.onViewChange = ({ zoom, minZoom }) => {
        const slider = q(".timeline-zoom-range");
        slider.min = String(Math.log2(minZoom));
        slider.step = "any";
        slider.value = String(Math.log2(zoom));
        const percent = `${Number((zoom * 100).toPrecision(3))}%`;
        q(".timeline-zoom-range").setAttribute("aria-valuetext", percent);
        q(".timeline-zoom-value").textContent = percent;
        q('[data-action="timeline-zoom-out"]').disabled = zoom <= minZoom + 1e-9;
        q('[data-action="timeline-zoom-in"]').disabled = zoom >= 32;
    };
    q(".timeline-zoom-range").addEventListener("input", event => timeline.setZoom(2 ** event.target.valueAsNumber), events);
    q(".timeline-zoom-range").addEventListener("keydown", event => {
        if (event.isComposing || event.ctrlKey || event.metaKey || event.altKey)
            return;
        const increments = { ArrowLeft: -.25, ArrowDown: -.25, ArrowRight: .25, ArrowUp: .25, PageDown: -1, PageUp: 1 };
        if (!(event.key in increments) && event.key !== "Home" && event.key !== "End")
            return;
        event.preventDefault();
        event.stopPropagation();
        const power = Math.round((Math.log2(timeline.getZoom()) + (increments[event.key] ?? 0)) * 1e12) / 1e12;
        timeline.setZoom(event.key === "Home" ? timeline.getMinZoom() : event.key === "End" ? 32 : 2 ** power);
    }, events);
    timeline.onViewChange({ zoom: timeline.getZoom(), minZoom: timeline.getMinZoom() });
    const cropDrag = bindCropDrag(q(".preview-crop-frame"), {
        bounds: q(".preview-crop-overlay"),
        getPosition() {
            // Settle playback before measuring the selected reference image.
            pausePlayback();
            return previewImageState === "loaded" ? { ...frameCrop(previewScene()) ?? { x: 0.5, y: 0.5 } } : null;
        },
        getGeometry() {
            const image = q(".preview-image");
            return previewImageState === "loaded" ? { sourceWidth: image.naturalWidth, sourceHeight: image.naturalHeight, outputWidth: project.width, outputHeight: project.height } : null;
        },
        onStart() { cropDraft = { id: previewScene().id, epoch: projectEpoch, slot: previewFrame, position: { ...frameCrop(previewScene()) ?? { x: 0.5, y: 0.5 } } }; },
        onChange(position) { if (cropDraft) {
            cropDraft.position = position;
            renderCrop();
        } },
        onEnd(position) {
            const draft = cropDraft;
            cropDraft = undefined;
            if (draft?.epoch === projectEpoch)
                setCrop(draft.id, position, draft.slot);
            else
                renderCrop();
        },
        onCancel() { cropDraft = undefined; renderCrop(); },
    });
    const previewResize = new ResizeObserver(() => { cropDrag.cancel(); renderCrop(); });
    previewResize.observe(q(".preview-stage"));
    const panelSplit = bindPanelSplit(root, q(".panel-divider"));
    function feedback(target, message = "", kind = "error") {
        if (disposed)
            return;
        const element = q(`.${target}-feedback`);
        element.textContent = message;
        element.hidden = !message;
        element.dataset.kind = kind;
        element.setAttribute("role", kind === "error" ? "alert" : "status");
    }
    const errorMessage = (error) => error instanceof Error ? error.message : String(error);
    function setAudioError(message = "", source = "other") { audioError = message; audioErrorSource = source; }
    const failure = (error, target = "settings") => feedback(target, errorMessage(error));
    function persist() { options.onChange?.(structuredClone(project)); }
    function selected() { return project.scenes.find(scene => scene.id === selectedId) ?? project.scenes[0]; }
    function previewScene() { return selected(); }
    function frameAsset(scene, slot = previewFrame) { return slot === "first" ? scene.image : scene.endImage; }
    function frameCrop(scene, slot = previewFrame) { return slot === "first" ? scene.crop : scene.endCrop; }
    function frameLabel(slot) { return slot === "first" ? "First frame" : "Last frame"; }
    function hasImages(scene) { return Boolean(scene.image || scene.endImage); }
    function sceneSlot(scene) {
        const remembered = scene.id === previewSceneId ? previewFrame : previewSlots.get(scene.id);
        return remembered && frameAsset(scene, remembered) ? remembered : scene.image ? "first" : scene.endImage ? "last" : "first";
    }
    function frameStrength(scene, slot) { return getImageStrength(project, scene, slot); }
    function renderStrengthScope() {
        q(".strength-scope-value").textContent = q(`[data-strength-scope="${strengthScope}"]`).textContent;
        root.querySelectorAll("[data-strength-scope]").forEach(button => button.setAttribute("aria-checked", String(button.dataset.strengthScope === strengthScope)));
    }
    function updateImageStrength(strength) {
        return { ...project, scenes: project.scenes.map(scene => {
                if (strengthScope !== "all" && scene.id !== selectedId)
                    return scene;
                const slots = strengthScope === "image" ? [sceneSlot(scene)] : ["first", "last"];
                let next = scene;
                for (const slot of slots)
                    if (frameAsset(scene, slot))
                        next = updateImage(next, slot, { strength });
                return next;
            }) };
    }
    function updateImage(scene, slot, edit, remove = false) {
        const imageKey = slot === "first" ? "image" : "endImage", cropKey = slot === "first" ? "crop" : "endCrop", strengthKey = slot === "first" ? "imageStrength" : "endImageStrength";
        const next = { ...scene };
        if (remove) {
            delete next[imageKey];
            delete next[cropKey];
            delete next[strengthKey];
        }
        else {
            if (edit.image)
                next[imageKey] = edit.image;
            if (Object.hasOwn(edit, "crop")) {
                if (edit.crop)
                    next[cropKey] = edit.crop;
                else
                    delete next[cropKey];
            }
            if (Object.hasOwn(edit, "strength")) {
                if (edit.strength !== undefined)
                    next[strengthKey] = edit.strength;
                else
                    delete next[strengthKey];
            }
        }
        return next;
    }
    function selectImage(id, slot) {
        if (!selectScene(id, false))
            return false;
        pausePlayback();
        cropDrag.cancel();
        const scene = selected(), index = project.scenes.indexOf(scene);
        previewSlots.set(id, slot);
        previewFrame = slot;
        previewSceneId = id;
        seekPlayback(sceneStartFrame(project, index) + (slot === "last" ? scene.durationFrames - 1 : 0));
        render();
        return true;
    }
    const imageTargetKey = ({ id, slot }) => JSON.stringify([id, slot]);
    function selectedAudio() { return project.audioSegments.find(segment => segment.id === selectedAudioId); }
    const seconds = (frames) => formatDuration(frames, project.fps);
    const visibleAudioEnd = (segment) => Math.min(project.fps * MAX_TIMELINE_SECONDS, segment.endFrame ?? (segment.startFrame >= totalFrames(project) ? segment.startFrame + project.fps : totalFrames(project)));
    function renderTimingCaption(selector, durationFrames, startFrame) {
        const frames = document.createElement("span"), start = document.createElement("span");
        frames.className = "timing-frames";
        frames.textContent = `${durationFrames} ${durationFrames === 1 ? "frame" : "frames"}`;
        start.className = "timing-start";
        start.textContent = `Start ${formatTime(startFrame, project.fps)}`;
        q(selector).replaceChildren(frames, document.createTextNode(" "), start);
    }
    function audioLabel(segment) { return segment.kind === "generate" ? "Generate audio" : segment.name ?? segment.asset.filename; }
    function selectAudio(id, seek = true) {
        if (renamingId)
            finishRename(renamingId, true);
        if (!finishAudioDraft() || !finishTextDrafts() || !finishSceneDrafts())
            return false;
        const segment = project.audioSegments.find(row => row.id === id);
        if (!segment)
            return false;
        cropDrag.cancel();
        mode = "audio";
        selectedAudioId = id;
        render();
        if (seek) {
            if (segment.startFrame < totalFrames(project))
                seekPlayback(segment.startFrame);
            timeline.revealRange(segment.startFrame, Math.max(segment.startFrame + project.fps, audioEnd(segment, totalFrames(project))));
        }
        return true;
    }
    function removeScene() {
        const index = project.scenes.findIndex(scene => scene.id === selectedId);
        if (project.scenes.length <= 1 || index < 0)
            return;
        pausePlayback();
        const imageKeys = new Set(["first", "last"]
            .map(slot => imageTargetKey({ id: selectedId, slot })));
        for (const [key, target] of pendingImageAdds)
            if (target.id === selectedId)
                imageKeys.add(key);
        for (const key of imageKeys) {
            imageUploadVersions.set(key, (imageUploadVersions.get(key) ?? 0) + 1);
            imageFeedback.delete(key);
            pendingImageAdds.delete(key);
        }
        const scenes = project.scenes.filter(scene => scene.id !== selectedId);
        const nextIndex = Math.max(0, index - 1);
        selectedId = scenes[nextIndex].id;
        commit({ ...project, scenes });
        seekPlayback(sceneStartFrame(project, nextIndex));
        timeline.revealRange(sceneStartFrame(project, nextIndex), sceneStartFrame(project, nextIndex) + selected().durationFrames);
        q(".timeline-canvas").focus({ preventScroll: true });
    }
    function removeAudio(id = selectedAudioId) {
        if (id !== selectedAudioId && !finishAudioDraft())
            return;
        const segment = project.audioSegments.find(row => row.id === id);
        if (!segment)
            return;
        const index = project.audioSegments.findIndex(row => row.id === segment.id), segments = project.audioSegments.filter(row => row.id !== segment.id);
        let next = segment.kind === "file" ? reconcileProvidedAudio({ ...project, audioSegments: segments }, project) : { ...project, audioSegments: segments };
        if (segment.kind === "generate")
            project.scenes.forEach((_, sceneIndex) => {
                const start = sceneStartFrame(project, sceneIndex), end = start + project.scenes[sceneIndex].durationFrames;
                if (segment.startFrame < end && (segment.endFrame ?? Infinity) > start &&
                    (segment.kind === "generate" || !segments.some(row => row.startFrame < end && (row.endFrame ?? Infinity) > start))) {
                    const hasFile = segments.some(row => row.kind === "file" && row.startFrame < end && (row.endFrame ?? Infinity) > start);
                    next = setSceneAudioMode(next, sceneIndex, hasFile ? "supplied" : "silent");
                }
            });
        selectedAudioId = segments[Math.min(index, segments.length - 1)]?.id ?? "";
        audioDraft = undefined;
        clearAudioDraftValidity();
        setAudioError();
        if (!segments.length)
            mode = "image";
        commit(next);
        q(".timeline-canvas").focus({ preventScroll: true });
    }
    function renderInsertHelp() {
        const index = project.scenes.findIndex(scene => scene.id === selectedId);
        const audioMode = sceneAudioMode(project, index);
        const label = audioMode === "mixed" ? "Choose mode" : audioMode === "supplied" ? "Provide audio" : audioMode === "generated" ? "Generate audio" : "Silent";
        q(".clip-audio-value").textContent = label;
        root.querySelectorAll("[data-audio-mode]").forEach(button => button.setAttribute("aria-checked", String(button.dataset.audioMode === audioMode)));
        const conflict = project.scenes.findIndex((_, index) => sceneAudioConflict(project, index));
        q(".audio-mode-feedback").hidden = conflict < 0;
        q(".audio-mode-feedback").textContent = conflict < 0 ? "" : audioModeError(conflict);
        renderAudioGuidance();
    }
    function renderAudioGuidance() {
        const scene = selected(), index = project.scenes.findIndex(row => row.id === scene.id);
        const { coveredFrames, totalFrames: duration } = sceneAudioCoverage(project, index);
        const remaining = duration - coveredFrames, enabled = sceneUsesAudioGuidance(scene);
        const control = q(".audio-guidance");
        control.setAttribute("aria-checked", String(enabled));
        control.disabled = !coveredFrames || sceneAudioConflict(project, index);
        const label = `Audio for ${sceneName(scene, index)}`;
        q(".audio-guidance-scope").textContent = label;
        q(".audio-guidance-scope").title = label;
        const displaySeconds = (frames) => String(Number((frames / project.fps).toFixed(3)));
        q(".audio-coverage").textContent = coveredFrames
            ? `Audio covers ${displaySeconds(coveredFrames)} of ${displaySeconds(duration)} seconds` : "No provided audio in this clip";
        q(".audio-coverage").title = `${coveredFrames} of ${duration} frames covered`;
        q(".audio-guidance-value").textContent = coveredFrames && !enabled ? "Soundtrack only" : "Audio guidance";
        q(".audio-coverage-value").textContent = coveredFrames ? `${displaySeconds(coveredFrames)} / ${displaySeconds(duration)} s covered` : "No provided audio";
        q(".audio-guidance-summary").title = `${label}. ${q(".audio-coverage").textContent}. ${enabled ? "Guidance on" : "Guidance off"}.`;
        q(".audio-guidance-help").textContent = !coveredFrames ? "Choose Provide audio to use this setting."
            : sceneAudioConflict(project, index) ? "Choose one audio mode to resolve this clip’s conflict."
                : remaining ? `The remaining ${displaySeconds(remaining)} seconds will be silent.` : "The recording covers the whole clip.";
        q(".audio-guidance-description").textContent = !coveredFrames || control.disabled ? "Saved per clip; audio edits keep this choice."
            : enabled ? remaining ? "Audio and silent gaps guide the video." : "Audio guides this clip’s video."
                : "Soundtrack only; visuals use prompt and images.";
        const start = sceneStartFrame(project, index);
        const intervals = project.audioSegments.flatMap(segment => {
            if (segment.kind !== "file")
                return [];
            const left = Math.max(start, segment.startFrame), right = Math.min(start + duration, audioEnd(segment, totalFrames(project)));
            if (right <= left)
                return [];
            const fill = document.createElement("span");
            fill.style.left = `${100 * (left - start) / duration}%`;
            fill.style.width = `${100 * (right - left) / duration}%`;
            return [fill];
        });
        q(".audio-coverage-bar").replaceChildren(...intervals);
    }
    function chooseAudioMode(audioMode) {
        if (!finishAudioDraft() || !finishTextDrafts() || !finishSceneDrafts())
            return;
        const index = project.scenes.findIndex(scene => scene.id === selectedId);
        const start = sceneStartFrame(project, index), end = start + selected().durationFrames;
        const hasFile = project.audioSegments.some(segment => segment.kind === "file" && segment.startFrame < end && (segment.endFrame ?? Infinity) > start);
        if (audioMode === "supplied" && !hasFile) {
            if (audioUploading) {
                setAudioError("An audio import is already in progress. Wait for it to finish.");
                renderAudioFeedback();
                return;
            }
            audioChooserTarget = { ...captureAudioTarget(sceneStartFrame(project, index)), sceneId: selectedId };
            q('[data-testid="audio-input"]').click();
            return;
        }
        invalidateAudioImport();
        pausePlayback();
        setAudioError();
        mode = "image";
        commit(setSceneAudioMode(project, index, audioMode));
    }
    function renderAudioEditor() {
        if (disposed)
            return;
        if (!project.audioSegments.some(segment => segment.id === selectedAudioId))
            selectedAudioId = project.audioSegments[0]?.id ?? "";
        if (!selectedAudioId)
            mode = "image";
        q(".scene-inspector").hidden = mode !== "image";
        q(".audio-inspector").hidden = mode !== "audio";
        const segment = selectedAudio();
        q(".audio-fields").hidden = !segment;
        q(".audio-empty-help").hidden = Boolean(segment);
        q(".audio-apply-button").hidden = segment?.kind !== "file";
        q(".audio-heading").textContent = segment ? audioLabel(segment) : "Audio timeline";
        q(".audio-heading").title = segment?.kind === "file" ? segment.asset.filename : "";
        if (segment) {
            const durationFrames = visibleAudioEnd(segment) - segment.startFrame;
            renderTimingCaption(".audio-start-time", durationFrames, segment.startFrame);
            for (const [field, value] of [["duration", seconds(visibleAudioEnd(segment) - segment.startFrame)], ["trim", segment.kind === "file" ? String(segment.sourceOffsetSamples / 48000) : "0"]]) {
                const input = q(`.audio-${field}`);
                input.disabled = segment.kind === "generate";
                if (!audioDraft || audioDraft.id !== segment.id || audioDraft.values[field] === undefined)
                    input.value = value;
                input.step = field === "trim" ? String(1 / 48000) : "any";
                input.min = "0";
                input.max = field === "trim" ? "600" : seconds(project.fps * MAX_TIMELINE_SECONDS - segment.startFrame);
            }
            root.querySelectorAll('[data-duration-step^="audio-"]').forEach(button => { button.disabled = segment.kind === "generate"; });
            q(".audio-file-fields").hidden = segment.kind !== "file";
            q(".audio-file-details").hidden = segment.kind !== "file";
            q(".audio-generation-help").hidden = segment.kind !== "generate";
            const duration = segment.kind === "file" ? playback.audioDuration(segment.asset) : 0;
            q(".audio-source-duration").textContent = duration ? `${duration.toFixed(3)} s source · no looping or stretching` : segment.kind === "file" ? "Loading source…" : "";
        }
        renderInsertHelp();
    }
    function clearAudioDraftValidity() {
        for (const field of ["duration", "trim"]) {
            const input = q(`.audio-${field}`);
            input.setCustomValidity("");
            input.removeAttribute("aria-invalid");
        }
        q(".audio-edit-feedback").hidden = true;
        q(".audio-edit-feedback").textContent = "";
    }
    function draftProject() {
        if (!audioDraft)
            return project;
        const draft = audioDraft, segment = project.audioSegments.find(row => row.id === draft.id);
        if (!segment)
            throw new Error("This audio segment no longer exists.");
        if (segment.kind === "generate")
            throw new Error("Generated audio covers the whole clip. Select the clip to change its duration.");
        const number = (field) => { const raw = draft.values[field]; if (raw === undefined)
            return; const value = Number(raw), maximum = field === "trim" ? 600 : MAX_TIMELINE_SECONDS; if (!raw.trim() || !Number.isFinite(value) || value < 0 || value > maximum)
            throw new Error(`${field === "trim" ? "Source start" : `Audio ${field}`} must be between 0 and ${maximum} seconds.`); return value; };
        const duration = number("duration"), trim = number("trim"), previousEnd = visibleAudioEnd(segment);
        const requestedEnd = duration === undefined ? previousEnd : segment.startFrame + (draft.durationFrames ?? durationFramesFromSeconds(duration, project.fps, previousEnd - segment.startFrame));
        if (requestedEnd <= segment.startFrame)
            throw new Error("Audio duration must be at least one frame.");
        const endFrame = duration === undefined || requestedEnd === previousEnd ? segment.endFrame : requestedEnd;
        const updated = { ...segment, endFrame, ...(trim !== undefined ? { sourceOffsetSamples: Math.round(trim * 48000) } : {}) };
        if (requestedEnd > previousEnd || updated.sourceOffsetSamples !== segment.sourceOffsetSamples) {
            const sourceDuration = playback.audioDuration(updated.asset);
            if (!sourceDuration)
                throw new Error("Wait for the audio source to finish loading.");
            if (requestedEnd > fileAudioEndLimit(updated, totalFrames(project), project.fps, sourceDuration)) {
                throw new Error("Audio duration cannot extend beyond the uploaded source. Trim the source less or choose a shorter duration.");
            }
        }
        return validateEdit(placeProvidedAudio(project, updated));
    }
    function openAudioRange() {
        if (!finishAudioDraft() || !finishTextDrafts() || !finishSceneDrafts())
            return;
        const segment = selectedAudio();
        if (segment?.kind !== "file")
            return;
        pausePlayback();
        audioRangeTarget = { id: segment.id, epoch: projectEpoch, revision: audioRevision };
        const covered = project.scenes.flatMap((scene, index) => {
            const start = sceneStartFrame(project, index);
            return segment.startFrame < start + scene.durationFrames && audioEnd(segment, totalFrames(project)) > start ? [index] : [];
        });
        for (const field of ["start", "end"]) {
            const select = q(`.audio-apply-${field}`);
            select.replaceChildren(...project.scenes.map((scene, index) => new Option(`${index + 1}. ${sceneName(scene, index)}`, scene.id)));
            select.value = project.scenes[covered[field === "start" ? 0 : covered.length - 1] ?? project.scenes.findIndex(scene => scene.id === selectedId)].id;
        }
        q(".audio-apply-error").hidden = true;
        q(".audio-apply-dialog").showModal();
    }
    function applyAudioRange() {
        try {
            const target = audioRangeTarget;
            if (!target || target.epoch !== projectEpoch || target.revision !== audioRevision)
                throw new Error("The timeline changed. Close this dialog and select the audio again.");
            const segment = project.audioSegments.find(row => row.id === target.id);
            if (segment?.kind !== "file")
                throw new Error("Select an uploaded audio file first.");
            const first = project.scenes.findIndex(scene => scene.id === q(".audio-apply-start").value);
            const last = project.scenes.findIndex(scene => scene.id === q(".audio-apply-end").value);
            if (first < 0 || last < first)
                throw new Error("The last clip must be the same as or after the first clip.");
            const startFrame = sceneStartFrame(project, first), endFrame = sceneStartFrame(project, last) + project.scenes[last].durationFrames;
            const updated = { ...segment, startFrame, endFrame };
            const sourceDuration = playback.audioDuration(segment.asset);
            if (!sourceDuration)
                throw new Error("Wait for the audio source to finish loading.");
            if (endFrame > fileAudioEndLimit(updated, totalFrames(project), project.fps, sourceDuration))
                throw new Error("This clip range is longer than the remaining source audio. Choose fewer clips or an earlier source start.");
            const next = validateEdit(placeProvidedAudio(project, updated));
            setAudioError();
            commit(next);
            q(".audio-apply-dialog").close();
            audioRangeTarget = undefined;
            timeline.revealRange(startFrame, endFrame);
        }
        catch (error) {
            const feedback = q(".audio-apply-error");
            feedback.textContent = errorMessage(error);
            feedback.hidden = false;
        }
    }
    function showAudioDraftError(error, focus = false) {
        const message = errorMessage(error), field = Object.keys(audioDraft?.values ?? {})[0] ?? "duration", input = q(`.audio-${field}`);
        input.setCustomValidity(message);
        input.setAttribute("aria-invalid", "true");
        q(".audio-edit-feedback").textContent = message;
        q(".audio-edit-feedback").hidden = false;
        if (focus) {
            mode = "audio";
            renderAudioEditor();
            input.focus();
        }
    }
    function finishAudioDraft(focus = false) {
        if (!audioDraft)
            return true;
        try {
            const next = draftProject();
            audioDraft = undefined;
            clearAudioDraftValidity();
            commit(next);
            return true;
        }
        catch (error) {
            showAudioDraftError(error, focus);
            return false;
        }
    }
    function openAudioChooser(replacementId) {
        if (!finishAudioDraft() || !finishTextDrafts() || !finishSceneDrafts())
            return;
        if (audioUploading) {
            setAudioError("An audio import is already in progress. Wait for it to finish.");
            renderAudioFeedback();
            return;
        }
        audioChooserTarget = captureAudioTarget(undefined, replacementId);
        q('[data-testid="audio-input"]').click();
    }
    function importAudio(files, target) {
        if (files.length !== 1) {
            setAudioError("Choose one audio file at a time.");
            renderAudioFeedback();
            return;
        }
        const file = files[0];
        const audio = file.type.startsWith("audio/") || (!file.type || file.type === "application/octet-stream") && /\.(wav|mp3|flac|ogg|m4a|aac|opus|aiff?|aif)$/i.test(file.name);
        if (audio)
            void uploadAudio(file, target);
        else {
            setAudioError("Choose an audio file for the audio timeline.");
            renderAudioFeedback();
        }
    }
    function openFrameChooser(slot) {
        if (!finishAudioDraft())
            return;
        const target = { ...captureImageTarget(), slot };
        if (!selectScene(target.id, false))
            return;
        sceneImageTarget = target;
        q('[data-testid="scene-image-input"]').click();
    }
    function setCrop(id, position, slot = previewFrame) {
        const crop = position.x === 0.5 && position.y === 0.5 && (position.scale ?? 1) === 1 ? undefined : position;
        commit({ ...project, scenes: project.scenes.map(scene => scene.id === id ? updateImage(scene, slot, { crop }) : scene) });
    }
    function pausePlayback() { transportRequest++; playback.pause(); }
    function seekPlayback(next) { transportRequest++; playback.seek(next); }
    function invalidateAudioImport(message = "Audio import cancelled because its destination changed.") {
        audioRevision++;
        transportRequest++;
        if (audioUploading) {
            audioUploadVersion++;
            audioUploading = false;
            setAudioError(message);
            renderAudioFeedback();
            renderTransport();
        }
    }
    function commit(next, preparedAudio) {
        cropDrag.cancel();
        let valid;
        try {
            valid = validateEdit(next);
        }
        catch (error) {
            render();
            failure(error);
            return;
        }
        const clipTiming = (value) => value.scenes.map(({ id, durationFrames, audioMode }) => [id, durationFrames, audioMode]);
        if (valid.fps !== project.fps || JSON.stringify(clipTiming(valid)) !== JSON.stringify(clipTiming(project)) || JSON.stringify(valid.audioSegments) !== JSON.stringify(project.audioSegments))
            invalidateAudioImport();
        transportRequest++;
        project = valid;
        history.commit(project);
        persist();
        playback.configure(project);
        render();
        void loadAudioIfChanged(preparedAudio);
    }
    function editScene(update) {
        commit({ ...project, scenes: project.scenes.map(scene => scene.id === selectedId ? update(scene) : scene) });
    }
    function sceneUpdate(update) {
        return { ...project, scenes: project.scenes.map(scene => scene.id === selectedId ? update(scene) : scene) };
    }
    function renderSampling() {
        const preset = project.samplingPreset;
        q(".preset-value").textContent = preset === "auto" ? "Auto" : preset === "distilled" ? "Distilled" : preset === "full" ? "Full" : "Saved settings";
        root.querySelectorAll("[data-preset]").forEach(button => button.setAttribute("aria-checked", String(button.dataset.preset === preset)));
        const summary = q(".sampling-summary");
        if (preset === undefined) {
            const saved = getSampling(project, selected());
            summary.textContent = `${saved.steps} steps · CFG ${saved.cfg}`;
            summary.title = "This project retains its saved sampling settings. Choose a preset to replace them.";
            return;
        }
        const detected = preset === "auto" ? modelProfile.preset : preset;
        if (!detected) {
            summary.textContent = modelProfile.reason;
            summary.title = modelProfile.reason;
            return;
        }
        const settings = SAMPLING_PRESETS[detected];
        summary.textContent = `${preset === "auto" ? `Detected: ${detected === "full" ? "Full" : "Distilled"} · ` : ""}${settings.steps} steps · CFG ${settings.cfg}`;
        summary.title = preset === "auto" ? modelProfile.checkpoint ?? modelProfile.reason : "Applies to every clip.";
    }
    function selectScene(id, seek = true) {
        if (renamingId)
            finishRename(renamingId, true);
        if (!finishAudioDraft() || !finishTextDrafts() || !finishSceneDrafts() || !project.scenes.some(scene => scene.id === id))
            return false;
        mode = "image";
        cropDrag.cancel();
        selectedId = id;
        render();
        if (seek) {
            const start = sceneStartFrame(project, project.scenes.findIndex(scene => scene.id === id));
            seekPlayback(start);
            timeline.revealRange(start, start + selected().durationFrames);
        }
        return true;
    }
    function beginRename(id) {
        const index = project.scenes.findIndex(scene => scene.id === id);
        if (index < 0)
            return;
        if (renamingId)
            finishRename(renamingId, true);
        if (!finishAudioDraft() || !finishTextDrafts() || !finishSceneDrafts())
            return;
        mode = "image";
        pausePlayback();
        selectedId = id;
        renamingId = id;
        renameDraft = sceneName(project.scenes[index], index);
        seekPlayback(sceneStartFrame(project, index));
        timeline.revealRange(sceneStartFrame(project, index), sceneStartFrame(project, index) + selected().durationFrames);
        render();
        const input = q('[data-testid="scene-name-input"]');
        input.focus({ preventScroll: true });
        input.select();
    }
    function finishRename(id, save, focus = false) {
        if (renamingId !== id || disposed)
            return;
        const name = renameDraft.trim();
        renamingId = undefined;
        const original = project.scenes.find(scene => scene.id === id);
        const changed = original && name !== (original.name ?? "") && (original.name !== undefined || name !== sceneName(original, project.scenes.indexOf(original)));
        if (save && changed) {
            commit({ ...project, scenes: project.scenes.map(scene => {
                    if (scene.id !== id)
                        return scene;
                    const { name: _name, ...rest } = scene;
                    return name ? { ...rest, name } : rest;
                }) });
        }
        else
            render();
        if (focus)
            q(".timeline-canvas").focus({ preventScroll: true });
    }
    function renderCrop() {
        if (disposed)
            return;
        const image = q(".preview-image");
        const overlay = q(".preview-crop-overlay");
        const scene = previewScene();
        const position = cropDraft?.id === scene.id && cropDraft.slot === previewFrame ? cropDraft.position : frameCrop(scene);
        const crop = previewImageState === "loaded" && !image.hidden && image.complete
            ? positionedCrop(image.naturalWidth, image.naturalHeight, project.width, project.height, position) : null;
        const imageStyle = getComputedStyle(image);
        const imageWidth = parseFloat(imageStyle.width), imageHeight = parseFloat(imageStyle.height);
        if (!crop || !imageWidth || !imageHeight) {
            overlay.hidden = true;
            q(".crop-area-label").hidden = true;
            cropSignature = "";
            return;
        }
        const signature = [lastPreviewImage, image.naturalWidth, image.naturalHeight, project.width, project.height, imageWidth, imageHeight, position?.x, position?.y, position?.scale].join(":");
        if (signature === cropSignature)
            return;
        cropSignature = signature;
        // Preserve fractional layout pixels; clientWidth/clientHeight round before ComfyUI's zoom.
        const scale = Math.min(imageWidth / image.naturalWidth, imageHeight / image.naturalHeight);
        const width = image.naturalWidth * scale;
        const height = image.naturalHeight * scale;
        const left = (imageWidth - width) / 2;
        const top = (parseFloat(imageStyle.top) || 0) + (imageHeight - height) / 2;
        Object.assign(overlay.style, { left: `${left}px`, top: `${top}px`, width: `${width}px`, height: `${height}px` });
        const label = q(".crop-area-label");
        label.hidden = false;
        label.style.left = `${Math.max(2, Math.min(imageWidth - label.offsetWidth - 2, left + (crop.x + crop.width / 2) * scale - label.offsetWidth / 2))}px`;
        label.style.top = `${Math.max(2, top + crop.y * scale - label.offsetHeight - 10)}px`;
        Object.assign(q(".preview-crop-frame").style, { left: `${crop.x * scale}px`, top: `${crop.y * scale}px`, width: `${crop.width * scale}px`, height: `${crop.height * scale}px` });
        const movable = crop.width < image.naturalWidth || crop.height < image.naturalHeight;
        q(".preview-crop-frame").tabIndex = 0;
        q(".preview-crop-frame").classList.toggle("is-movable", movable);
        q('[data-action="reset-crop"]').disabled = !position || (position.x === 0.5 && position.y === 0.5 && (position.scale ?? 1) === 1);
        overlay.hidden = false;
    }
    function renderImages() {
        const scene = selected(), slot = sceneSlot(scene), strip = q(".keyframe-strip");
        const asset = frameAsset(scene, slot);
        const target = JSON.stringify([projectEpoch, scene.id, slot, asset ? assetUrl(asset) : ""]);
        if (target !== strengthTarget) {
            strengthTarget = target;
            strengthScope = "image";
            closeMenu(q(".strength-scope-menu"));
        }
        renderStrengthScope();
        const slots = ["first", "last"];
        const signature = JSON.stringify([scene.id, slot, slots.map(target => [target, frameAsset(scene, target), frameLabel(target)])]);
        if (strip.dataset.signature !== signature) {
            strip.dataset.signature = signature;
            strip.replaceChildren(...slots.map(target => {
                const button = document.createElement("button"), asset = frameAsset(scene, target);
                button.type = "button";
                button.className = "keyframe-card";
                button.dataset.action = "select-image";
                button.dataset.slot = target;
                button.dataset.testid = `keyframe-${target}`;
                button.setAttribute("aria-pressed", String(slot === target));
                button.dataset.empty = String(!asset);
                button.setAttribute("aria-label", `${asset ? "Show" : "Add"} ${frameLabel(target).toLowerCase()}`);
                if (asset) {
                    const image = document.createElement("img");
                    image.src = assetUrl(asset);
                    image.alt = "";
                    image.draggable = false;
                    button.append(image);
                }
                else {
                    const empty = document.createElement("span");
                    empty.className = "keyframe-empty";
                    empty.textContent = "+";
                    button.append(empty);
                }
                const label = document.createElement("span");
                label.textContent = frameLabel(target);
                button.append(label);
                return button;
            }));
        }
    }
    function renderPreview() {
        const scene = selected(), active = { scene, index: project.scenes.indexOf(scene) };
        if (cropDraft && cropDraft.id !== active.scene.id)
            cropDrag.cancel();
        if (previewSceneId !== active.scene.id) {
            previewSceneId = active.scene.id;
            const remembered = previewSlots.get(active.scene.id);
            previewFrame = remembered && frameAsset(active.scene, remembered) ? remembered : active.scene.image ? "first" : active.scene.endImage ? "last" : "first";
        }
        if (!frameAsset(active.scene, previewFrame))
            previewFrame = active.scene.image ? "first" : active.scene.endImage ? "last" : "first";
        previewSlots.set(active.scene.id, previewFrame);
        const image = q(".preview-image");
        const asset = frameAsset(active.scene), url = asset ? assetUrl(asset) : "";
        image.alt = `${frameLabel(previewFrame)} reference`;
        if (url !== lastPreviewImage) {
            cropDrag.cancel();
            lastPreviewImage = url;
            previewImageState = url ? "loading" : "empty";
            if (url)
                image.src = url;
            else
                image.removeAttribute("src");
        }
        image.hidden = previewImageState !== "loaded";
        renderCrop();
        q(".image-controls").classList.toggle("is-empty", !asset);
        const hasReference = hasImages(active.scene);
        const slotName = frameLabel(previewFrame);
        q(".preview-scene-name").textContent = sceneName(active.scene, active.index);
        q(".preview-scene-name").title = sceneName(active.scene, active.index);
        q(".preview-frame-label").textContent = `${hasReference ? `${slotName}${asset ? "" : " · Empty"}` : "Reference frames · Optional"} · ${project.width} × ${project.height} px`;
        q(".preview-image-actions").setAttribute("aria-label", `${slotName} image actions for ${sceneName(active.scene, active.index)}`);
        q(".preview-image-actions").setAttribute("role", "group");
        for (const [action, verb] of [["reset-crop", "Reset crop for"], ["preview-image", "Replace"], ["remove-image", "Remove"]]) {
            const button = q(`[data-action="${action}"]`);
            button.title = `${verb} ${slotName.toLowerCase()} image in ${sceneName(active.scene, active.index)}`;
            button.setAttribute("aria-label", button.title);
        }
        const pendingAdd = [...pendingImageAdds.values()].reverse().find(target => target.id === active.scene.id && imageFeedback.has(imageTargetKey(target)));
        const pendingStatus = pendingAdd && imageFeedback.get(imageTargetKey(pendingAdd));
        const status = pendingStatus ?? imageFeedback.get(imageTargetKey({ id: active.scene.id, slot: previewFrame }));
        feedback("image", status ? `${pendingStatus ? `${frameLabel(pendingAdd.slot)}: ` : ""}${status.message}` : previewImageState === "error" ? "Could not load this image. Replace it to try again." : "", status?.kind);
        renderImages();
    }
    function renderRename() {
        const input = q(".scene-name-input"), bounds = renamingId ? timeline.sceneBounds(renamingId) : null;
        input.hidden = !bounds;
        if (!bounds)
            return;
        const canvas = q(".timeline-canvas");
        const width = Math.min(Math.max(140, bounds.width - 8), canvas.clientWidth - 24);
        Object.assign(input.style, { left: `${Math.max(12, Math.min(bounds.left + 4, canvas.clientWidth - width - 12))}px`, top: `${bounds.top + 4}px`, width: `${width}px` });
        if (input.value !== renameDraft)
            input.value = renameDraft;
    }
    function render(resetDrafts = false) {
        if (resetDrafts)
            for (const input of root.querySelectorAll(".global-prompt, .scene-prompt")) {
                input.setCustomValidity("");
                input.removeAttribute("aria-invalid");
            }
        const drafts = resetDrafts ? [] : numericInputs.filter(({ input, target }) => (input.validity.customError || input.validity.badInput) &&
            (target !== "scene" || selectedId === renderedSceneId) &&
            (!input.classList.contains("image-strength") || hasImages(selected()))).map(({ input, target }) => ({ input, target, message: input.validationMessage }));
        const draftInputs = new Set(drafts.map(draft => draft.input));
        const focused = root.getRootNode().activeElement;
        // Background loads and preview updates must not rewrite a number being typed.
        if (!resetDrafts && focused instanceof HTMLInputElement && numericInputs.some(({ input, target }) => input === focused && (target !== "scene" || selectedId === renderedSceneId)))
            draftInputs.add(focused);
        const setNumber = (selector, value) => {
            const input = q(selector);
            numericValues.set(input, value);
            if (!draftInputs.has(input) && input.value !== value)
                input.value = value;
        };
        for (const { input } of numericInputs) {
            input.setCustomValidity("");
            input.removeAttribute("aria-invalid");
        }
        feedback("settings");
        feedback("scene");
        if (!project.scenes.some(scene => scene.id === selectedId))
            selectedId = project.scenes[0].id;
        if (renamingId && !project.scenes.some(scene => scene.id === renamingId))
            renamingId = undefined;
        const oversized = project.scenes.filter(scene => scene.durationFrames > project.fps * MAX_SCENE_SECONDS);
        const limitFeedback = q(".scene-limit-feedback");
        limitFeedback.hidden = oversized.length === 0;
        limitFeedback.textContent = oversized.length ? `${oversized.length} ${oversized.length === 1 ? "clip exceeds" : "clips exceed"} the ${MAX_SCENE_SECONDS}-second generation limit. Shorten them or divide them into clips of ${MAX_SCENE_SECONDS} seconds or less before running.` : "";
        const scene = selected();
        const index = project.scenes.findIndex(row => row.id === scene.id);
        q(".selected-scene-heading").textContent = sceneName(scene, index);
        q(".selected-scene-heading").title = sceneName(scene, index);
        q(".scene-prompt").setAttribute("aria-description", `Prompt for ${sceneName(scene, index)} only`);
        if (!q(".global-prompt").validity.customError)
            q(".global-prompt").value = project.globalPrompt;
        if (!q(".scene-prompt").validity.customError)
            q(".scene-prompt").value = scene.prompt;
        setNumber(".scene-duration", seconds(scene.durationFrames));
        q(".scene-duration").step = "any";
        q(".scene-duration").min = "0";
        q(".scene-duration").max = String(MAX_SCENE_SECONDS);
        renderTimingCaption(".frame-help", scene.durationFrames, sceneStartFrame(project, index));
        const addSceneButton = q('[data-action="add-scene"]');
        addSceneButton.disabled = project.scenes.length >= 100;
        addSceneButton.title = project.scenes.length >= 100 ? "A video supports up to 100 clips." : "Add a clip";
        q('[data-action="undo"]').disabled = !history.canUndo;
        q('[data-action="redo"]').disabled = !history.canRedo;
        const videoFrames = totalFrames(project);
        q(".video-duration").textContent = `Video length: ${seconds(videoFrames)} s`;
        q(".total-time").textContent = `/ ${formatPlaybackTime(videoFrames, project.fps)}`;
        q(".total-time").setAttribute("aria-label", `Total duration: ${totalFrames(project)} frames, ${seconds(totalFrames(project))} seconds`);
        q(".timecode-format").textContent = `${project.fps} fps`;
        setNumber(".width", String(project.width));
        setNumber(".height", String(project.height));
        q(".width").max = "4096";
        q(".height").max = "4096";
        setNumber(".fps", String(project.fps));
        setNumber(".seed", String(project.seed));
        q(".seed").max = String(Number.MAX_SAFE_INTEGER);
        renderSampling();
        q(".scene-settings").hidden = !hasImages(scene);
        setNumber(".image-strength", String(frameStrength(scene, sceneSlot(scene))));
        q(".image-strength-label").textContent = "Strength";
        q(".image-strength").title = `${frameLabel(sceneSlot(scene))} strength`;
        q(".image-strength-field").hidden = !hasImages(scene);
        renderAudioEditor();
        timeline.setProject(project, selectedId, mode === "audio" ? selectedAudioId : "");
        renderRename();
        renderPreview();
        renderedSceneId = selectedId;
        for (const { input, target, message } of drafts) {
            input.setCustomValidity(message);
            input.setAttribute("aria-invalid", "true");
            feedback(target, message);
        }
    }
    async function loadAudioIfChanged(preparedAudio) {
        const key = [...new Set(project.audioSegments.flatMap(segment => segment.kind === "file" ? [assetUrl(segment.asset)] : []))].sort().join("\n");
        if (key === lastAudioAsset && !preparedAudio)
            return;
        const version = ++audioLoadVersion;
        lastAudioAsset = key;
        audioLoading = Boolean(key);
        renderAudioFeedback();
        renderTransport();
        try {
            await playback.loadAudioAssets(preparedAudio);
            if (!disposed && version === audioLoadVersion && audioErrorSource === "load")
                setAudioError();
        }
        catch (error) {
            if (version === audioLoadVersion) {
                lastAudioAsset = "";
                setAudioError(errorMessage(error), "load");
            }
        }
        finally {
            if (!disposed && version === audioLoadVersion) {
                audioLoading = false;
                renderAudioEditor();
                renderAudioFeedback();
                renderTransport();
            }
        }
    }
    function captureImageTarget() {
        pausePlayback();
        const id = selectedId;
        return { id, epoch: projectEpoch, slot: previewFrame };
    }
    function removeImage(target = captureImageTarget()) {
        const key = imageTargetKey(target);
        if (target.id === selectedId && target.slot === sceneSlot(selected())) {
            for (const selector of [".image-strength"]) {
                const input = q(selector);
                input.setCustomValidity("");
                input.removeAttribute("aria-invalid");
                input.value = numericValues.get(input) ?? "";
            }
        }
        else if (!finishSceneDrafts())
            return;
        imageUploadVersions.set(key, (imageUploadVersions.get(key) ?? 0) + 1);
        imageFeedback.delete(key);
        pendingImageAdds.delete(key);
        commit({ ...project, scenes: project.scenes.map(scene => scene.id === target.id ? updateImage(scene, target.slot, {}, true) : scene) });
    }
    async function uploadImage(file, target) {
        const { id, epoch, slot } = target;
        const previewAtStart = previewFrame;
        if (epoch !== projectEpoch || disposed || !project.scenes.some(scene => scene.id === id))
            return;
        const newImage = !frameAsset(project.scenes.find(scene => scene.id === id), slot);
        const key = imageTargetKey(target), version = (imageUploadVersions.get(key) ?? 0) + 1;
        for (const [previousKey, previous] of pendingImageAdds) {
            if (previous.id === id && imageFeedback.get(previousKey)?.kind === "error") {
                pendingImageAdds.delete(previousKey);
                imageFeedback.delete(previousKey);
            }
        }
        if (newImage)
            pendingImageAdds.set(key, target);
        imageUploadVersions.set(key, version);
        imageFeedback.set(key, { message: "Uploading image…", kind: "loading", target });
        renderPreview();
        const current = () => !disposed && epoch === projectEpoch && imageUploadVersions.get(key) === version && project.scenes.some(scene => scene.id === id);
        try {
            const uploaded = await uploadAsset(file, "image");
            if (!current())
                return;
            const next = validateEdit({ ...project, scenes: project.scenes.map(scene => {
                    if (scene.id !== id)
                        return scene;
                    return updateImage(scene, slot, { image: uploaded.asset, crop: undefined });
                }) });
            imageFeedback.delete(key);
            pendingImageAdds.delete(key);
            if (newImage && selectedId === id && previewFrame === previewAtStart && finishSceneDrafts()) {
                previewFrame = slot;
                previewSlots.set(id, slot);
            }
            commit(next);
        }
        catch (error) {
            if (current()) {
                imageFeedback.set(key, { message: errorMessage(error), kind: "error", target });
                renderPreview();
            }
        }
    }
    function addScene() {
        if (!finishAudioDraft() || !finishTextDrafts() || !finishSceneDrafts())
            return;
        try {
            const scene = createScene(project.fps * 2);
            const next = validateEdit({ ...project, scenes: [...project.scenes, scene] });
            mode = "image";
            selectedId = scene.id;
            commit(next);
            selectScene(scene.id);
            q(".timeline-canvas").focus({ preventScroll: true });
        }
        catch (error) {
            failure(error, "project");
        }
    }
    function captureAudioTarget(at, replacementId) {
        pausePlayback();
        return { epoch: projectEpoch, revision: audioRevision, fps: project.fps, frame: at ?? frame, ...(replacementId ? { replacementId } : {}) };
    }
    function audioTargetCurrent(target) {
        return !disposed && target.epoch === projectEpoch && target.revision === audioRevision && target.fps === project.fps && (!target.replacementId || project.audioSegments.some(segment => segment.id === target.replacementId));
    }
    async function uploadAudio(file, target) {
        if (audioUploading) {
            setAudioError("An audio import is already in progress. Wait for it to finish.");
            renderAudioFeedback();
            return;
        }
        if (!audioTargetCurrent(target)) {
            setAudioError("Audio import cancelled because its destination changed.");
            renderAudioFeedback();
            return;
        }
        if (!target.replacementId && target.frame >= project.fps * MAX_TIMELINE_SECONDS) {
            setAudioError("Move the playhead before the supported timeline end to add audio.");
            renderAudioFeedback();
            return;
        }
        const version = ++audioUploadVersion;
        audioUploading = true;
        setAudioError();
        pausePlayback();
        renderAudioFeedback();
        renderTransport();
        const current = () => audioTargetCurrent(target) && audioUploadVersion === version;
        try {
            const uploaded = await uploadAsset(file, "audio");
            if (!current())
                return;
            const url = assetUrl(uploaded.asset), prepared = await playback.prepareAudio(url);
            if (!current())
                return;
            const replacement = project.audioSegments.find(segment => segment.id === target.replacementId);
            const destination = target.sceneId ? project.scenes.findIndex(scene => scene.id === target.sceneId) : -1;
            const uploadEnd = destination >= 0 ? sceneStartFrame(project, destination) + project.scenes[destination].durationFrames : totalFrames(project);
            const incoming = replacement
                ? { id: replacement.id, kind: "file", startFrame: replacement.startFrame, endFrame: replacement.endFrame, asset: uploaded.asset, name: file.name, sourceOffsetSamples: 0 }
                : { id: crypto.randomUUID(), kind: "file", startFrame: target.frame, endFrame: Math.min(target.frame < totalFrames(project) ? uploadEnd : project.fps * MAX_TIMELINE_SECONDS, target.frame + Math.ceil(uploaded.sampleCount * project.fps / uploaded.sampleRate)), asset: uploaded.asset, name: file.name, sourceOffsetSamples: 0 };
            const sourceEnd = fileAudioEndLimit(incoming, totalFrames(project), project.fps, uploaded.sampleCount / uploaded.sampleRate);
            incoming.endFrame = Math.min(audioEnd(incoming, totalFrames(project)), sourceEnd);
            if (incoming.endFrame <= incoming.startFrame)
                throw new Error("The uploaded audio is shorter than one timeline frame.");
            const next = validateEdit(placeProvidedAudio(project, incoming));
            audioUploading = false;
            setAudioError();
            audioDraft = undefined;
            if (finishTextDrafts() && finishSceneDrafts()) {
                mode = "audio";
                selectedAudioId = incoming.id;
            }
            commit(next, { url, buffer: prepared });
        }
        catch (error) {
            if (current())
                setAudioError(errorMessage(error));
        }
        finally {
            if (!disposed && audioUploadVersion === version) {
                audioUploading = false;
                renderAudioFeedback();
                renderTransport();
            }
        }
    }
    function renderAudioFeedback() {
        feedback("audio", audioError || (audioUploading ? "Uploading audio…" : audioLoading ? "Loading audio…" : ""), audioError ? "error" : "loading");
    }
    function renderTransport() {
        const button = q('[data-action="play"]');
        const loading = audioLoading || audioUploading;
        button.disabled = loading;
        button.setAttribute("aria-busy", String(loading));
        button.textContent = loading ? "…" : icon(playback.playing ? "pause" : "play");
        button.setAttribute("aria-label", loading ? "Loading audio" : playback.playing ? "Pause" : "Play");
    }
    async function togglePlay() {
        const request = ++transportRequest, requestedProject = project;
        feedback("playback");
        if (playback.playing) {
            pausePlayback();
            return;
        }
        if (audioLoading || audioUploading)
            return;
        if (project.audioSegments.some(segment => segment.kind === "file") && !lastAudioAsset) {
            await loadAudioIfChanged();
            // A later edit, seek, pause or project replacement owns transport intent.
            // A stale retry must also never start while the replacement source loads.
            if (disposed || request !== transportRequest || requestedProject !== project || audioLoading || audioUploading || !lastAudioAsset)
                return;
        }
        await playback.play();
    }
    function restore(value) { cropDrag.cancel(); timeline.cancel(); audioDraft = undefined; clearAudioDraftValidity(); invalidateAudioImport(); projectEpoch++; imageUploadVersions.clear(); imageFeedback.clear(); pendingImageAdds.clear(); project = value; persist(); playback.configure(project); render(true); void loadAudioIfChanged(); }
    function reorderScene(sourceId, targetId) {
        const from = project.scenes.findIndex(scene => scene.id === sourceId);
        const to = project.scenes.findIndex(scene => scene.id === targetId);
        if (from < 0 || to < 0 || from === to)
            return;
        pausePlayback();
        const atEnd = frame >= totalFrames(project);
        const active = sceneAtFrame(project, Math.min(frame, totalFrames(project) - 1));
        const sceneOffset = frame - active.startFrame;
        const scenes = [...project.scenes];
        const [moved] = scenes.splice(from, 1);
        scenes.splice(to, 0, moved);
        commit({ ...project, scenes });
        const previewIndex = project.scenes.findIndex(scene => scene.id === active.scene.id);
        seekPlayback(atEnd ? totalFrames(project) : sceneStartFrame(project, previewIndex) + sceneOffset);
    }
    playback.onFrame = (next, playing) => {
        if (cropDraft && next !== frame)
            cropDrag.cancel();
        frame = next;
        timeline.setFrame(frame);
        q(".playhead-time").textContent = formatPlaybackTime(frame, project.fps);
        renderTransport();
        renderPreview();
    };
    playback.onWaveforms = waveforms => { timeline.setWaveforms(waveforms); renderAudioEditor(); };
    playback.onError = error => failure(error, "playback");
    timeline.onSeek = next => seekPlayback(next);
    timeline.onSelect = id => selectScene(id, false);
    timeline.onRename = beginRename;
    timeline.onReorder = reorderScene;
    timeline.onReorderStart = () => pausePlayback();
    timeline.onResize = (sceneId, durationFrames) => commit({ ...project, scenes: project.scenes.map(scene => scene.id === sceneId ? { ...scene, durationFrames } : scene) });
    timeline.onResizeStart = () => pausePlayback();
    timeline.onAudioSelect = id => selectAudio(id, false);
    timeline.onAudioStart = () => { pausePlayback(); invalidateAudioImport(); };
    timeline.onAudioPreview = message => {
        const preview = q(".audio-drag-preview");
        preview.textContent = message;
        preview.hidden = !message;
    };
    timeline.onAudioChange = (segment, edit) => {
        if (segment.kind === "generate" || !finishAudioDraft())
            return;
        try {
            const next = validateEdit(placeProvidedAudio(project, segment));
            setAudioError();
            commit(next);
            if (edit === "move")
                timeline.revealRange(segment.startFrame, audioEnd(segment, totalFrames(project)));
        }
        catch (error) {
            setAudioError(errorMessage(error));
            renderAudioFeedback();
        }
    };
    timeline.onSceneRemove = removeScene;
    timeline.onAudioRemove = removeAudio;
    timeline.onAudioDrop = (files, at) => { if (finishAudioDraft())
        importAudio(files, captureAudioTarget(at)); };
    root.addEventListener("click", event => {
        const button = event.target.closest("[data-action]");
        if (!button || button.disabled)
            return;
        if (!["undo", "redo"].includes(button.dataset.action ?? "") && !finishTextDrafts())
            return;
        switch (button.dataset.action) {
            case "add-scene":
                addScene();
                break;
            case "select-image": {
                const slot = button.dataset.slot, id = selected().id;
                if (frameAsset(selected(), slot))
                    selectImage(id, slot);
                else
                    openFrameChooser(slot);
                break;
            }
            case "set-preset": {
                try {
                    flushPendingEdits(false);
                    commit(validateEdit({ ...project, samplingPreset: button.dataset.preset }));
                }
                catch (error) {
                    failure(error, "settings");
                    renderSampling();
                }
                closeMenu(q(".generation-menu"), true);
                break;
            }
            case "set-strength-scope": {
                if (!finishSceneDrafts())
                    break;
                strengthScope = button.dataset.strengthScope;
                renderStrengthScope();
                closeMenu(q(".strength-scope-menu"), true);
                break;
            }
            case "undo":
                restore(history.undo());
                break;
            case "redo":
                restore(history.redo());
                break;
            case "play":
                void togglePlay().catch(error => failure(error, "playback"));
                break;
            case "start":
                seekPlayback(0);
                break;
            case "timeline-zoom-in":
                timeline.setZoom(timeline.getZoom() * 2);
                break;
            case "timeline-zoom-out":
                timeline.setZoom(timeline.getZoom() / 2);
                break;
            case "timeline-fit":
                timeline.fit();
                break;
            case "preview-image":
                previewImageTarget = captureImageTarget();
                q('[data-testid="preview-image-input"]').click();
                break;
            case "reset-crop":
                cropDrag.cancel();
                pausePlayback();
                setCrop(previewScene().id, { x: 0.5, y: 0.5 });
                break;
            case "reset-sampling": {
                const input = q(".image-strength");
                input.setCustomValidity("");
                input.removeAttribute("aria-invalid");
                input.value = String(getSampling(project, selected()).imageStrength);
                commit(updateImageStrength(undefined));
                break;
            }
            case "add-generated-audio":
                chooseAudioMode("generated");
                closeMenu(q(".add-audio-menu"), true);
                break;
            case "set-supplied-audio":
                chooseAudioMode("supplied");
                closeMenu(q(".add-audio-menu"), true);
                break;
            case "silent-audio":
                chooseAudioMode("silent");
                closeMenu(q(".add-audio-menu"), true);
                break;
            case "audio":
                openAudioChooser();
                closeMenu(q(".add-audio-menu"), true);
                break;
            case "replace-audio":
                openAudioChooser(selectedAudioId);
                break;
            case "open-audio-range":
                openAudioRange();
                break;
            case "apply-audio-range":
                applyAudioRange();
                break;
            case "cancel-audio-range":
                q(".audio-apply-dialog").close();
                audioRangeTarget = undefined;
                break;
            case "remove-image": {
                removeImage();
                break;
            }
        }
    }, events);
    function finishTextDrafts() {
        const input = [...root.querySelectorAll(".global-prompt, .scene-prompt")].find(input => input.validity.customError);
        if (!input)
            return true;
        failure(new Error(input.validationMessage), input.classList.contains("global-prompt") ? "settings" : "scene");
        return false;
    }
    function finishSceneDrafts() {
        for (const selector of [".scene-duration", ".image-strength"]) {
            if (selector === ".image-strength" && !hasImages(selected()))
                continue;
            const input = q(selector);
            if (input.validity.customError || input.validity.badInput || !input.value.trim()) {
                failure(new Error(input.validationMessage || `${input.getAttribute("aria-label")} must be a number.`), "scene");
                return false;
            }
        }
        return true;
    }
    for (const selector of [".global-prompt", ".scene-prompt"])
        q(selector).addEventListener("input", event => {
            const input = event.target, target = selector === ".global-prompt" ? "settings" : "scene";
            try {
                const next = validateEdit(selector === ".global-prompt" ? { ...project, globalPrompt: input.value } : sceneUpdate(scene => ({ ...scene, prompt: input.value })));
                input.setCustomValidity("");
                input.removeAttribute("aria-invalid");
                feedback(target);
                commit(next);
            }
            catch (error) {
                input.setCustomValidity(errorMessage(error));
                input.setAttribute("aria-invalid", "true");
                failure(error, target);
            }
        }, events);
    q(".audio-guidance").addEventListener("click", event => {
        const control = event.currentTarget, enabled = !sceneUsesAudioGuidance(selected()), id = selected().id;
        if (control.disabled || !finishAudioDraft() || !finishTextDrafts() || !finishSceneDrafts()) {
            renderAudioGuidance();
            return;
        }
        if (selected().id !== id || sceneUsesAudioGuidance(selected()) === enabled) {
            renderAudioGuidance();
            return;
        }
        pausePlayback();
        editScene(scene => ({ ...scene, audioGuidance: enabled }));
    }, events);
    const nameInput = q(".scene-name-input");
    nameInput.addEventListener("input", () => { if (renamingId)
        renameDraft = nameInput.value; }, events);
    nameInput.addEventListener("keydown", event => {
        if (!renamingId || event.isComposing || !["Enter", "Escape"].includes(event.key))
            return;
        event.preventDefault();
        event.stopPropagation();
        finishRename(renamingId, event.key === "Enter", true);
    }, events);
    nameInput.addEventListener("blur", () => { if (renamingId)
        finishRename(renamingId, true); }, events);
    timeline.onLayoutChange = renderRename;
    const menus = Array.from(root.querySelectorAll(".editor-menu"));
    function closeMenu(menu, focus = false) {
        menu.open = false;
        if (focus)
            menu.querySelector("summary").focus({ preventScroll: true });
    }
    root.ownerDocument.addEventListener("pointerdown", event => {
        for (const menu of menus)
            if (!event.composedPath().includes(menu))
                closeMenu(menu);
    }, events);
    for (const menu of menus) {
        menu.addEventListener("toggle", () => { if (menu.open)
            for (const other of menus)
                if (other !== menu)
                    closeMenu(other); }, events);
        menu.addEventListener("focusout", event => { if (!menu.contains(event.relatedTarget))
            closeMenu(menu); }, events);
        menu.addEventListener("keydown", event => {
            if (event.key === "Escape") {
                event.preventDefault();
                event.stopPropagation();
                closeMenu(menu, true);
                return;
            }
            if (!["ArrowDown", "ArrowUp", "Home", "End"].includes(event.key))
                return;
            const buttons = Array.from(menu.querySelectorAll("button:not(:disabled)"));
            if (!buttons.length)
                return;
            event.preventDefault();
            event.stopPropagation();
            menu.open = true;
            const index = buttons.indexOf(event.target);
            const next = event.key === "Home" ? 0 : event.key === "End" ? buttons.length - 1 : event.key === "ArrowDown" ? (index + 1) % buttons.length : index < 0 ? buttons.length - 1 : (index - 1 + buttons.length) % buttons.length;
            buttons[next].focus();
        }, events);
    }
    function bindNumber(selector, update, target = "settings") {
        const input = q(selector);
        numericInputs.push({ input, target });
        const describedBy = [input.getAttribute("aria-describedby"), `${editorId}-${target}-feedback`].filter(Boolean).join(" ");
        input.setAttribute("aria-describedby", describedBy);
        const apply = (event) => {
            const raw = input.value;
            try {
                if (!Number.isFinite(input.valueAsNumber))
                    throw new Error(`${input.getAttribute("aria-label") ?? "Value"} must be a number.`);
                const next = validateEdit(update(input.valueAsNumber));
                input.setCustomValidity("");
                input.removeAttribute("aria-invalid");
                feedback(target);
                commit(next);
                // Preserve valid in-progress typing (e.g. trailing decimals) until blur.
                if (event.type === "input")
                    input.value = raw;
                else
                    input.value = numericValues.get(input) ?? raw;
            }
            catch (error) {
                input.setCustomValidity(errorMessage(error));
                input.setAttribute("aria-invalid", "true");
                failure(error, target);
            }
        };
        input.addEventListener("input", apply, events);
        input.addEventListener("change", apply, events);
        input.addEventListener("blur", () => {
            if (!input.validity.customError && !input.validity.badInput)
                input.value = numericValues.get(input) ?? input.value;
        }, events);
        input.addEventListener("keydown", event => {
            if (event.isComposing)
                return;
            if (event.key === "Enter") {
                event.preventDefault();
                apply(new Event("change"));
            }
            if (event.key === "Escape") {
                event.preventDefault();
                input.value = numericValues.get(input) ?? input.value;
                input.setCustomValidity("");
                input.removeAttribute("aria-invalid");
                render();
            }
        }, events);
    }
    function flushPendingEdits(forGeneration = true) {
        if (forGeneration && audioUploading) {
            throw new Error("Wait for the provided audio upload to finish before generating.");
        }
        if (forGeneration && [...imageFeedback.values()].some(({ kind, target }) => kind === "loading" && target.epoch === projectEpoch && project.scenes.some(scene => scene.id === target.id))) {
            throw new Error("Wait for image uploads to finish before generating.");
        }
        if (!finishAudioDraft(true))
            throw new Error(q(".audio-edit-feedback").textContent || "Invalid audio timing.");
        if (forGeneration)
            timeline.flushPendingEdits();
        for (const { input, target } of numericInputs) {
            if (input.validity.customError || input.validity.badInput || !input.value.trim()) {
                const message = input.validationMessage || `${input.getAttribute("aria-label") ?? "Value"} must be a number.`;
                feedback(target, message);
                throw new Error(message);
            }
        }
        if (!finishTextDrafts())
            throw new Error(q(".global-prompt").validationMessage || q(".scene-prompt").validationMessage || "Invalid prompt.");
        if (renamingId)
            finishRename(renamingId, true);
        if (!forGeneration) {
            let snapshot = timeline.snapshotProject();
            if (cropDraft) {
                const { id, position, slot } = cropDraft;
                const crop = position.x === 0.5 && position.y === 0.5 && (position.scale ?? 1) === 1 ? undefined : position;
                snapshot = { ...snapshot, scenes: snapshot.scenes.map(scene => scene.id === id ? updateImage(scene, slot, { crop }) : scene) };
            }
            return structuredClone(validateEdit(snapshot));
        }
        if (cropDraft) {
            const { id, position, slot } = cropDraft;
            cropDrag.cancel();
            setCrop(id, position, slot);
        }
        validateProject(project);
        validateGenerationAudio(project);
        return structuredClone(project);
    }
    function bindDurationStepper(kind, step) {
        const input = q(`.${kind}-duration`);
        input.addEventListener("keydown", event => {
            if (event.isComposing || event.altKey || event.ctrlKey || event.metaKey || !["ArrowUp", "ArrowDown"].includes(event.key))
                return;
            event.preventDefault();
            event.stopPropagation();
            step(event.key === "ArrowUp" ? 1 : -1);
        }, events);
        for (const [name, direction] of [["up", 1], ["down", -1]]) {
            const button = q(`[data-duration-step="${kind}-${name}"]`);
            let repeat;
            const stop = () => { clearTimeout(repeat); repeat = undefined; };
            button.addEventListener("pointerdown", event => {
                if (event.button !== 0)
                    return;
                event.preventDefault();
                event.stopPropagation();
                stop();
                input.focus({ preventScroll: true });
                button.setPointerCapture(event.pointerId);
                step(direction);
                const again = () => { step(direction); repeat = setTimeout(again, 75); };
                repeat = setTimeout(again, 400);
            }, events);
            for (const event of ["pointerup", "pointercancel", "lostpointercapture"])
                button.addEventListener(event, stop, events);
            // Keyboard and assistive clicks have no preceding pointerdown.
            button.addEventListener("click", event => { event.preventDefault(); if (event.detail === 0)
                step(direction); }, events);
            abort.signal.addEventListener("abort", stop, { once: true });
        }
    }
    bindDurationStepper("scene", direction => {
        const scene = selected(), minimum = minSceneFrames(scene);
        const durationFrames = Math.max(minimum, Math.min(Math.max(project.fps * MAX_SCENE_SECONDS, scene.durationFrames), scene.durationFrames + direction));
        const input = q(".scene-duration");
        input.setCustomValidity("");
        input.removeAttribute("aria-invalid");
        commit(sceneUpdate(current => ({ ...current, durationFrames })));
        input.value = seconds(selected().durationFrames);
    });
    bindDurationStepper("audio", direction => {
        if (!finishAudioDraft(true))
            return;
        const segment = selectedAudio();
        if (!segment)
            return;
        const currentFrames = visibleAudioEnd(segment) - segment.startFrame;
        const durationFrames = Math.max(1, Math.min(project.fps * MAX_TIMELINE_SECONDS - segment.startFrame, currentFrames + direction));
        audioDraft = { id: segment.id, values: { duration: seconds(durationFrames) }, durationFrames };
        q(".audio-duration").value = seconds(durationFrames);
        clearAudioDraftValidity();
        finishAudioDraft(true);
    });
    for (const field of ["duration", "trim"]) {
        const input = q(`.audio-${field}`);
        input.addEventListener("input", () => {
            if (!selectedAudio())
                return;
            if (!audioDraft) {
                invalidateAudioImport();
                audioDraft = { id: selectedAudioId, values: {} };
            }
            audioDraft.values[field] = input.value;
            if (field === "duration")
                delete audioDraft.durationFrames;
            clearAudioDraftValidity();
            try {
                draftProject();
            }
            catch (error) {
                showAudioDraftError(error);
            }
        }, events);
        input.addEventListener("blur", () => { finishAudioDraft(); }, events);
        input.addEventListener("keydown", event => {
            if (event.key === "Enter") {
                event.preventDefault();
                finishAudioDraft(true);
            }
            if (event.key === "Escape") {
                event.preventDefault();
                audioDraft = undefined;
                clearAudioDraftValidity();
                renderAudioEditor();
            }
        }, events);
    }
    bindNumber(".scene-duration", value => sceneUpdate(scene => ({ ...scene,
        // An oversized legacy scene may round to "20.0"; entering the cap repairs it.
        durationFrames: scene.durationFrames > project.fps * MAX_SCENE_SECONDS && value === MAX_SCENE_SECONDS
            ? project.fps * MAX_SCENE_SECONDS : durationFramesFromSeconds(value, project.fps, scene.durationFrames),
    })), "scene");
    for (const key of ["width", "height", "fps", "seed"])
        bindNumber(`.${key}`, value => ({ ...project, [key]: value }));
    bindNumber(".image-strength", value => updateImageStrength(value), "scene");
    q('[data-testid="scene-image-input"]').addEventListener("change", event => {
        const input = event.target, file = input.files?.[0], target = sceneImageTarget;
        sceneImageTarget = undefined;
        input.value = "";
        if (file && target) {
            void uploadImage(file, target);
        }
    }, events);
    q('[data-testid="scene-image-input"]').addEventListener("cancel", () => { sceneImageTarget = undefined; }, events);
    q('[data-testid="preview-image-input"]').addEventListener("change", event => {
        const input = event.target;
        const file = input.files?.[0];
        const target = previewImageTarget ?? captureImageTarget();
        previewImageTarget = undefined;
        input.value = "";
        if (file)
            void uploadImage(file, target);
    }, events);
    q('[data-testid="preview-image-input"]').addEventListener("cancel", () => { previewImageTarget = undefined; }, events);
    q('[data-testid="audio-input"]').addEventListener("change", event => {
        const input = event.target, target = audioChooserTarget ?? captureAudioTarget();
        audioChooserTarget = undefined;
        if (target && input.files?.length)
            importAudio(input.files, target);
        input.value = "";
    }, events);
    q('[data-testid="audio-input"]').addEventListener("cancel", () => { audioChooserTarget = undefined; }, events);
    // The preview is display-only; ignored drops must not open files or reach the graph.
    for (const type of ["dragover", "drop"])
        q(".preview-stage").addEventListener(type, event => {
            event.preventDefault();
            event.stopPropagation();
            if (event.dataTransfer)
                event.dataTransfer.dropEffect = "none";
        }, events);
    root.addEventListener("keydown", event => {
        if (event.target.closest(".timeline-scroll"))
            return;
        if (event.defaultPrevented || event.isComposing)
            return;
        const target = event.target;
        if (event.key === "Escape" && target.matches(".global-prompt, .scene-prompt")) {
            const input = target;
            if (input.validity.customError) {
                event.preventDefault();
                input.setCustomValidity("");
                input.removeAttribute("aria-invalid");
                render();
            }
        }
        if (target.matches("input, textarea, select") || target.isContentEditable)
            return;
        if ((event.metaKey || event.ctrlKey) && event.key.toLowerCase() === "z") {
            event.preventDefault();
            restore(event.shiftKey ? history.redo() : history.undo());
        }
        if (event.code === "Space" && !target.closest("button, summary")) {
            event.preventDefault();
            void togglePlay().catch(error => failure(error, "playback"));
        }
        if ((event.key === "ArrowLeft" || event.key === "ArrowRight") && target.tagName !== "CANVAS" && !target.closest("button, summary, [role=menu]")) {
            event.preventDefault();
            seekPlayback(frame + (event.key === "ArrowRight" ? 1 : -1));
        }
    }, events);
    q(".preview-image").addEventListener("load", event => {
        const image = event.currentTarget;
        if (lastPreviewImage && image.complete && image.naturalWidth > 0 && image.currentSrc === new URL(lastPreviewImage, document.baseURI).href) {
            previewImageState = "loaded";
            renderPreview();
        }
    }, events);
    q(".preview-image").addEventListener("error", event => {
        const image = event.currentTarget;
        if (lastPreviewImage && image.getAttribute("src") === lastPreviewImage && image.complete && !image.naturalWidth) {
            previewImageState = "error";
            renderPreview();
        }
    }, events);
    root.tabIndex = -1;
    render();
    void loadAudioIfChanged();
    function setGenerationStatus(status) {
        if (disposed)
            return;
        const row = q(".generation-status"), text = q(".generation-status-text");
        const nextText = status?.text ?? "";
        // These updates describe execution only; they must never enter project history or serialization.
        if (text.textContent !== nextText)
            text.textContent = nextText;
        row.hidden = !status;
        if (status)
            row.dataset.state = status.state;
        else
            delete row.dataset.state;
        q(".generation-activity").hidden = status?.state !== "running";
    }
    function replaceProject(next) {
        if (disposed)
            return;
        const loaded = readProject(next);
        setGenerationStatus(null);
        cropDrag.cancel();
        project = loaded;
        history = new History(loaded);
        selectedId = loaded.scenes[0].id;
        selectedAudioId = loaded.audioSegments[0]?.id ?? "";
        renamingId = undefined;
        audioDraft = undefined;
        clearAudioDraftValidity();
        audioRevision++;
        timeline.cancel();
        projectEpoch++;
        audioUploadVersion++;
        imageUploadVersions.clear();
        imageFeedback.clear();
        pendingImageAdds.clear();
        audioUploading = false;
        setAudioError();
        for (const target of ["project", "image", "audio", "playback"])
            feedback(target);
        // An open native chooser still belongs to its captured project epoch.
        // Its eventual selection is ignored by uploadImage after this replacement.
        mode = "image";
        previewSceneId = "";
        previewFrame = "first";
        previewSlots.clear();
        menus.forEach(menu => closeMenu(menu));
        playback.configure(project);
        seekPlayback(0);
        render(true);
        timeline.fit();
        renderAudioFeedback();
        void loadAudioIfChanged();
    }
    return {
        getProject: () => structuredClone(project),
        setProject: replaceProject,
        setModelProfile(profile) { if (!disposed) {
            modelProfile = { ...profile };
            renderSampling();
        } },
        setGenerationStatus,
        flushPendingEdits,
        dispose() { if (disposed)
            return; cropDrag.dispose(); panelSplit.dispose(); disposed = true; abort.abort(); previewResize.disconnect(); playback.dispose(); timeline.dispose(); root.remove(); },
    };
}
//# sourceMappingURL=app.js.map