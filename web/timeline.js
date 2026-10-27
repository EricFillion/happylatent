import { assetUrl, minSceneFrames, sceneAtFrame, sceneName, sceneStartFrame, totalFrames } from "./domain.js";
import { AUDIO_SAMPLE_RATE, MAX_SCENE_SECONDS, MAX_TIMELINE_SECONDS, audioEnd, fileAudioEndLimit, frameToSample, placeProvidedAudio, reflowSceneAudio } from "./audio.js";
import { positionedCrop } from "./crop.js";
const TIMELINE_HEIGHT = 160;
const DEFAULT_VISIBLE_SECONDS = 20;
const MIN_ZOOM = DEFAULT_VISIBLE_SECONDS / MAX_TIMELINE_SECONDS;
/** One canvas draws the arrangement and supports pointer and keyboard clip selection. */
export class Timeline {
    canvas;
    scrollbar;
    project;
    frame = 0;
    waveforms = new Map();
    observer;
    gesture;
    hoveredEdge;
    selectedId = "";
    selectedAudioId = "";
    zoom = 1;
    scrollOffset = 0;
    resizeView;
    committingView;
    edgeScrollRequest;
    edgeScrollTime;
    thumbnails = new Map();
    disposed = false;
    audioPreviewMessage = "";
    onViewChange = () => { };
    onLayoutChange = () => { };
    onSeek = () => { };
    onSelect = () => { };
    onRename = () => { };
    onReorder = () => { };
    onReorderStart = () => { };
    onResize = () => { };
    onResizeStart = () => { };
    onAudioSelect = () => { };
    onAudioChange = () => { };
    onAudioStart = () => { };
    onAudioPreview = () => { };
    onAudioRemove = () => { };
    onSceneRemove = () => { };
    onAudioDrop = () => { };
    constructor(canvas, project, scrollbar) {
        this.canvas = canvas;
        this.scrollbar = scrollbar;
        this.project = project;
        this.observer = new ResizeObserver(() => { this.pointerCancel(); this.draw(); });
        this.observer.observe(canvas);
        canvas.addEventListener("pointerdown", this.pointerDown);
        canvas.addEventListener("pointermove", this.pointerMove);
        canvas.addEventListener("pointerleave", this.pointerLeave);
        canvas.addEventListener("pointerup", this.pointerUp);
        canvas.addEventListener("pointercancel", this.pointerCancel);
        canvas.addEventListener("lostpointercapture", this.pointerCancel);
        canvas.addEventListener("keydown", this.keyDown);
        canvas.addEventListener("dblclick", this.doubleClick);
        canvas.addEventListener("dragover", this.dragOver);
        canvas.addEventListener("dragleave", this.dragLeave);
        canvas.addEventListener("drop", this.drop);
        canvas.addEventListener("wheel", this.wheel, { passive: false });
        scrollbar?.addEventListener("scroll", this.scroll);
        scrollbar?.addEventListener("keydown", this.scrollKeyDown);
        canvas.title = "Ruler: seconds (s). 100% zoom shows 20 seconds. Fit shows all clips. Scroll to reveal more space. Drag clips to reorder or their right edge to resize. Hold a clip right edge near the viewport edge to scroll and extend. Generated audio follows its clip. Drag provided audio across clips to switch them to Provided audio. Existing provided audio cannot overlap. Drag either provided-audio edge to trim within its source duration. Audio edges snap to clip boundaries. Shift-scroll to pan; Ctrl/Cmd-scroll to zoom. Alt+Left/Right selects clips; Alt+Home/End selects the first/last clip. Enter or F2 renames a clip.";
    }
    setProject(project, selectedId, selectedAudioId = "") {
        const view = this.committingView;
        if (project !== this.project)
            this.pointerCancel();
        const leftFrame = this.scrollOffset / this.pixelsPerFrame();
        const previousZoom = this.zoom, previousMinimum = this.getMinZoom();
        this.project = project;
        this.selectedId = selectedId;
        this.selectedAudioId = selectedAudioId;
        if (view) {
            this.zoom = Math.max(this.getMinZoom(), Math.min(32, view.scale * this.referenceFrames() / Math.max(1, this.canvas.clientWidth - 24)));
            this.scrollOffset = view.scroll;
        }
        else {
            this.zoom = Math.max(this.getMinZoom(), this.zoom);
            this.scrollOffset = leftFrame * this.pixelsPerFrame();
        }
        this.draw();
        if (view || this.zoom !== previousZoom || this.getMinZoom() !== previousMinimum)
            this.notifyView();
    }
    syncThumbnails() {
        const scale = this.pixelsPerFrame();
        let start = 0;
        const urls = new Set(this.project.scenes.flatMap(scene => {
            const left = 12 + start * scale - this.scrollOffset;
            start += scene.durationFrames;
            const right = 12 + start * scale - this.scrollOffset - 3;
            return Math.min(right, this.canvas.clientWidth - 12) - Math.max(left, 12) > 20
                ? [scene.image, scene.endImage].flatMap(asset => asset ? [assetUrl(asset)] : []) : [];
        }));
        for (const [url, entry] of this.thumbnails) {
            if (!urls.has(url)) {
                entry.image.onload = entry.image.onerror = null;
                this.thumbnails.delete(url);
            }
        }
        for (const url of urls) {
            if (this.thumbnails.has(url))
                continue;
            const entry = { image: new Image(), ready: false };
            this.thumbnails.set(url, entry);
            entry.image.onload = () => {
                if (this.disposed || this.thumbnails.get(url) !== entry)
                    return;
                entry.ready = entry.image.naturalWidth > 0 && entry.image.naturalHeight > 0;
                this.draw();
            };
            entry.image.onerror = () => {
                if (this.disposed || this.thumbnails.get(url) !== entry)
                    return;
                entry.ready = false;
                this.draw();
            };
            entry.image.src = url;
        }
    }
    getZoom() { return this.zoom; }
    getMinZoom() { return MIN_ZOOM; }
    referenceFrames() { return this.project.fps * DEFAULT_VISIBLE_SECONDS; }
    notifyView() { this.onViewChange({ zoom: this.zoom, minZoom: this.getMinZoom() }); }
    /** Actual clips, without the temporary empty viewport padding used by edge scrolling. */
    contentEndFrame(preview = false) {
        const gesture = preview && this.gesture && "active" in this.gesture && this.gesture.active ? this.gesture : undefined;
        const frames = totalFrames(this.project) + (gesture?.kind === "scene-resize" ? gesture.frames - gesture.initialFrames : 0);
        return Math.max(1, frames, ...this.project.audioSegments.map(segment => this.displayAudioEnd(gesture?.kind === "audio" && gesture.original.id === segment.id ? gesture.draft : segment, frames)));
    }
    horizonFrame() { return this.project.fps * MAX_TIMELINE_SECONDS; }
    activeRight() { return Math.min(this.canvas.clientWidth - 12, 12 + this.horizonFrame() * this.pixelsPerFrame() - this.scrollOffset); }
    withinTimeline(event) {
        const { x } = this.localPoint(event);
        const right = Math.min(this.canvas.clientWidth, 12 + this.horizonFrame() * this.pixelsPerFrame() - this.scrollOffset);
        return x >= 0 && x <= right;
    }
    /** Compact short panels, but never stretch tracks to fill added vertical space. */
    trackScale() { return Math.min(1, (this.canvas.clientHeight || TIMELINE_HEIGHT) / TIMELINE_HEIGHT); }
    /** Visible scene rectangle in canvas-local CSS pixels, suitable for an inline editor. */
    sceneBounds(id) {
        const index = this.project.scenes.findIndex(scene => scene.id === id);
        if (index < 0 || !this.canvas.clientWidth)
            return null;
        const scale = this.pixelsPerFrame(), scene = this.project.scenes[index];
        const start = 12 + sceneStartFrame(this.project, index) * scale - this.scrollOffset;
        const left = Math.max(12, start), right = Math.min(this.canvas.clientWidth - 12, start + Math.max(1, scene.durationFrames * scale - 3));
        const heightScale = this.trackScale();
        return right > left ? { left, top: 36 * heightScale, width: right - left, height: 50 * heightScale } : null;
    }
    setZoom(zoom) { this.zoomAt(zoom, this.canvas.clientWidth / 2); }
    fit() { this.pointerCancel(); this.zoom = Math.max(this.getMinZoom(), Math.min(32, this.referenceFrames() / this.contentEndFrame())); this.scrollOffset = 0; this.draw(); this.notifyView(); }
    revealRange(startFrame, endFrame) {
        const scale = this.pixelsPerFrame(), width = Math.max(1, this.canvas.clientWidth - 24);
        const left = Math.max(0, startFrame) * scale, right = Math.max(startFrame, endFrame) * scale;
        if (left >= this.scrollOffset && right <= this.scrollOffset + width)
            return;
        this.pointerCancel();
        this.scrollOffset = left < this.scrollOffset || right - left > width ? left : right - width;
        this.draw();
    }
    extentFrames() {
        const scale = this.pixelsPerFrame();
        const visibleEnd = (this.scrollOffset + Math.max(1, this.canvas.clientWidth - 24)) / scale;
        // Keep twenty seconds of empty space reachable beyond the clips. Panning reveals more empty space
        // without rescaling any existing clip or allocating an enormous canvas.
        return Math.min(this.horizonFrame(), Math.max(this.contentEndFrame(true), visibleEnd) + this.referenceFrames());
    }
    displayAudioEnd(segment, frames) {
        return Math.min(this.horizonFrame(), segment.endFrame ?? (segment.startFrame >= frames ? segment.startFrame + this.project.fps : frames));
    }
    pixelsPerFrame() { return this.resizeView?.panned ? this.resizeView.scale : Math.max(1, this.canvas.clientWidth - 24) * this.zoom / this.referenceFrames(); }
    syncScroll() {
        const width = Math.max(1, this.canvas.clientWidth - 24);
        const contentWidth = this.extentFrames() * this.pixelsPerFrame();
        this.scrollOffset = Math.max(0, Math.min(contentWidth - width, this.scrollOffset));
        if (this.scrollbar) {
            const spacer = this.scrollbar.firstElementChild;
            if (spacer)
                spacer.style.width = `${contentWidth + 24}px`;
            this.scrollbar.scrollLeft = this.scrollOffset;
        }
    }
    zoomAt(zoom, anchorX) {
        if (!Number.isFinite(zoom))
            return;
        this.pointerCancel();
        const anchor = Math.max(0, Math.min(this.canvas.clientWidth - 24, anchorX - 12));
        const frame = (this.scrollOffset + anchor) / this.pixelsPerFrame();
        this.zoom = Math.max(this.getMinZoom(), Math.min(32, zoom));
        this.scrollOffset = frame * this.pixelsPerFrame() - anchor;
        this.draw();
        this.notifyView();
    }
    scroll = () => {
        const offset = this.scrollbar?.scrollLeft ?? 0;
        if (Math.abs(offset - this.scrollOffset) < 1)
            return;
        this.pointerCancel();
        this.scrollOffset = offset;
        this.draw();
    };
    scrollKeyDown = (event) => {
        const width = Math.max(1, this.canvas.clientWidth - 24);
        const movement = { ArrowLeft: -40, ArrowRight: 40, PageUp: -width, PageDown: width, Home: -Infinity, End: Infinity };
        if (!(event.key in movement))
            return;
        event.preventDefault();
        event.stopPropagation();
        this.pointerCancel();
        this.scrollOffset = event.key === "Home" ? 0 : event.key === "End" ? this.contentEndFrame() * this.pixelsPerFrame() - width : this.scrollOffset + movement[event.key];
        this.draw();
    };
    wheel = (event) => {
        event.stopPropagation();
        if (this.localPoint(event).x > this.activeRight())
            return;
        if (event.ctrlKey || event.metaKey) {
            event.preventDefault();
            this.zoomAt(this.zoom * Math.exp(-event.deltaY * .002), this.localPoint(event).x);
        }
        else if (event.deltaX || event.shiftKey) {
            event.preventDefault();
            this.pointerCancel();
            const units = event.deltaMode === 1 ? 16 : event.deltaMode === 2 ? this.canvas.clientWidth : 1;
            this.scrollOffset += (event.deltaX || event.deltaY) * units;
            this.draw();
        }
    };
    setFrame(frame) { this.frame = frame; this.canvas.setAttribute("aria-valuenow", String(frame)); this.draw(); }
    setWaveforms(waveforms) { this.waveforms = waveforms; this.draw(); }
    /** Queueing commits the same visible draft as pointer release. */
    flushPendingEdits() {
        // An invalid visible placement must not queue a different, hidden arrangement.
        if (this.gesture?.kind === "audio" && this.gesture.active)
            this.snapshotProject();
        this.commitGesture();
    }
    /** Workflow autosave captures a visible edit without ending its pointer gesture. */
    snapshotProject() {
        const gesture = this.gesture;
        if (!gesture || gesture.kind === "seek" || !gesture.active)
            return this.project;
        if (gesture.kind === "scene-resize")
            return reflowSceneAudio({ ...this.project, scenes: this.project.scenes.map(scene => scene.id === gesture.sceneId ? { ...scene, durationFrames: gesture.frames } : scene) }, this.project);
        if (gesture.kind === "scene") {
            const from = this.project.scenes.findIndex(scene => scene.id === gesture.sceneId);
            const to = this.project.scenes.findIndex(scene => scene.id === gesture.targetId);
            if (from < 0 || to < 0 || from === to)
                return this.project;
            const scenes = [...this.project.scenes], [moved] = scenes.splice(from, 1);
            scenes.splice(to, 0, moved);
            return reflowSceneAudio({ ...this.project, scenes }, this.project);
        }
        return gesture.draft.kind === "file" ? placeProvidedAudio(this.project, gesture.draft) : this.project;
    }
    cancel() { this.pointerCancel(); }
    pointerFrame(event) {
        const x = Math.max(0, Math.min(this.activeRight() - 12, this.localPoint(event).x - 12));
        return Math.min(this.horizonFrame(), Math.round((this.scrollOffset + x) / this.pixelsPerFrame()));
    }
    localPoint(event) {
        const rect = this.canvas.getBoundingClientRect();
        return { x: (event.clientX - rect.left) * this.canvas.clientWidth / rect.width, y: (event.clientY - rect.top) * this.canvas.clientHeight / rect.height / this.trackScale() };
    }
    scale() { return this.pixelsPerFrame() * this.canvas.getBoundingClientRect().width / this.canvas.clientWidth; }
    screenPixels(pixels) {
        return pixels * this.canvas.clientWidth / Math.max(1, this.canvas.getBoundingClientRect().width);
    }
    pointerDown = (event) => {
        if (event.button !== 0 || this.gesture || !this.withinTimeline(event))
            return;
        event.preventDefault();
        event.stopPropagation();
        this.canvas.setPointerCapture(event.pointerId);
        this.canvas.focus();
        const pointer = { pointerId: event.pointerId, startX: event.clientX, startY: event.clientY };
        const audio = this.pointerAudio(event);
        if (audio?.segment.kind === "generate") {
            this.gesture = { ...pointer, kind: "seek" };
            if (this.onAudioSelect(audio.segment.id) === false) {
                this.pointerCancel();
                return;
            }
            this.onSeek(this.pointerFrame(event));
            return;
        }
        if (audio) {
            this.gesture = { ...pointer, kind: "audio", original: audio.segment, draft: audio.segment, edge: audio.edge, scale: this.scale(), active: false };
            if (audio.edge === "end" && this.zoom < 1)
                this.beginResizeView(event.clientX, audioEnd(audio.segment, totalFrames(this.project)));
            if (this.onAudioSelect(audio.segment.id) === false) {
                this.pointerCancel();
                return;
            }
            if (!audio.edge)
                this.onSeek(this.pointerFrame(event));
            return;
        }
        const resizing = this.pointerResizeScene(event);
        const sceneId = resizing?.id ?? this.pointerScene(event);
        this.gesture = resizing ? { ...pointer, kind: "scene-resize", sceneId: resizing.id, initialFrames: resizing.durationFrames, frames: resizing.durationFrames, scale: this.scale(), active: false }
            : sceneId ? { ...pointer, kind: "scene", sceneId, active: false } : { ...pointer, kind: "seek" };
        if (resizing)
            this.beginResizeView(event.clientX, sceneStartFrame(this.project, this.project.scenes.indexOf(resizing)) + resizing.durationFrames);
        if (sceneId && this.onSelect(sceneId) === false) {
            this.pointerCancel();
            return;
        }
        if (!resizing)
            this.onSeek(this.pointerFrame(event));
    };
    pointerResizeScene(event) {
        const { x: localX, y: localY } = this.localPoint(event);
        if (localY < 28 || localY >= 94 || !this.withinTimeline(event))
            return;
        const scale = this.pixelsPerFrame(), x = (frame) => 12 + frame * scale - this.scrollOffset;
        let start = 0;
        return this.project.scenes.find((scene, index) => {
            const left = x(start);
            start += scene.durationFrames;
            const right = Math.max(left + 1, x(start) - 3);
            // Keep a central body target even when graph zoom makes clips very narrow.
            const handle = Math.min(this.screenPixels(20), Math.max(0, right - left) * .35);
            const outside = index === this.project.scenes.length - 1 ? this.screenPixels(8) : 3;
            return right >= 12 && right <= this.canvas.clientWidth - 12 && localX >= right - handle && localX <= right + outside;
        });
    }
    pointerScene(event) {
        const rect = this.canvas.getBoundingClientRect();
        const { x, y } = this.localPoint(event), frame = this.pointerFrame(event);
        if (event.clientX < rect.left || event.clientX > rect.right || x < 12 || !this.withinTimeline(event) || y < 34 || y > 88 || frame >= totalFrames(this.project))
            return;
        return sceneAtFrame(this.project, frame)?.scene.id;
    }
    pointerAudio(event) {
        const { x, y } = this.localPoint(event);
        if (y < 94 || y > 150 || !this.withinTimeline(event))
            return;
        const frames = totalFrames(this.project), scale = this.pixelsPerFrame(), at = (frame) => 12 + frame * scale - this.scrollOffset;
        for (const [index, segment] of this.project.audioSegments.entries()) {
            const left = at(segment.startFrame), right = at(this.displayAudioEnd(segment, frames));
            if (right <= left)
                continue;
            if (segment.kind === "generate") {
                if (y >= 100 && y <= 140 && x >= Math.max(12, left) && x < Math.min(this.canvas.clientWidth - 12, right))
                    return { segment };
                continue;
            }
            // Trim targets stay easy to grab at graph zoom, with the middle 40% left for moving.
            // Empty gaps and the canvas gutter also belong to the real boundary, never a clipped viewport edge.
            const handle = Math.min(this.screenPixels(20), (right - left) * .3);
            const previous = this.project.audioSegments[index - 1], next = this.project.audioSegments[index + 1];
            const before = Math.min(this.screenPixels(8), previous ? Math.max(0, left - at(this.displayAudioEnd(previous, frames))) / 2 : left);
            const after = Math.min(this.screenPixels(8), next ? Math.max(0, at(next.startFrame) - right) / 2 : this.canvas.clientWidth - right);
            const start = left >= 12 && left <= this.canvas.clientWidth - 12 && x >= left - before && x <= left + handle;
            const end = right >= 12 && right <= this.canvas.clientWidth - 12 && x >= right - handle && x <= right + after && audioEnd(segment, frames) > segment.startFrame;
            const edge = start && (!end || Math.abs(x - left) < Math.abs(x - right)) ? "start" : end ? "end" : undefined;
            if (edge)
                return { segment, edge };
            if (y >= 100 && y <= 140 && x >= Math.max(12, left) && x < Math.min(this.canvas.clientWidth - 12, right))
                return { segment };
        }
    }
    audioSourceStartFrame(segment) {
        if (segment.kind !== "file")
            return;
        const origin = frameToSample(segment.startFrame, this.project.fps) - segment.sourceOffsetSamples;
        if (origin < 0)
            return; // The source begins before the project timeline.
        let low = 0, high = segment.startFrame;
        while (low < high) {
            const middle = Math.floor((low + high) / 2);
            if (frameToSample(middle, this.project.fps) < origin)
                low = middle + 1;
            else
                high = middle;
        }
        return low;
    }
    audioDraft(gesture, delta) {
        const original = gesture.original, frames = totalFrames(this.project);
        if (original.kind === "generate")
            return original;
        const lower = 0, upper = this.horizonFrame();
        const end = audioEnd(original, frames);
        if (gesture.edge === "end") {
            if (delta === 0)
                return original;
            const maximum = Math.min(upper, fileAudioEndLimit(original, frames, this.project.fps, this.waveforms.get(assetUrl(original.asset))?.duration));
            if (delta > 0 && end >= maximum)
                return original;
            const endFrame = Math.max(original.startFrame + 1, Math.min(delta > 0 ? maximum : upper, end + delta));
            // Returning to the original boundary is a no-op, including following-end blocks.
            return endFrame === end ? original : { ...original, endFrame };
        }
        if (gesture.edge === "start") {
            let startFrame = Math.max(lower, Math.min(Math.max(original.startFrame, end - 1), original.startFrame + delta));
            if (original.kind === "file") {
                const sourceAt = (frame) => original.sourceOffsetSamples + frameToSample(frame, this.project.fps) - frameToSample(original.startFrame, this.project.fps);
                // Keep sample alignment during trimming; only the source-beginning snap
                // absorbs the subframe remainder that cannot be represented on the timeline.
                if (sourceAt(startFrame) < 0) {
                    let low = startFrame, high = original.startFrame;
                    while (low < high) {
                        const middle = Math.floor((low + high) / 2);
                        if (sourceAt(middle) < 0)
                            low = middle + 1;
                        else
                            high = middle;
                    }
                    startFrame = low;
                }
                else if (sourceAt(startFrame) > AUDIO_SAMPLE_RATE * 600) {
                    let low = original.startFrame, high = startFrame;
                    while (low < high) {
                        const middle = Math.ceil((low + high) / 2);
                        if (sourceAt(middle) <= AUDIO_SAMPLE_RATE * 600)
                            low = middle;
                        else
                            high = middle - 1;
                    }
                    startFrame = low;
                }
                const atSourceStart = delta < 0 && startFrame === this.audioSourceStartFrame(original);
                return { ...original, startFrame, sourceOffsetSamples: atSourceStart ? 0 : sourceAt(startFrame) };
            }
            return original;
        }
        const duration = this.displayAudioEnd(original, frames) - original.startFrame;
        const startFrame = Math.max(0, Math.min(upper - duration, original.startFrame + delta));
        return startFrame === original.startFrame ? original : { ...original, startFrame, endFrame: startFrame + duration };
    }
    updateAudioDraft(gesture, delta) {
        gesture.snapFrame = undefined;
        gesture.draft = this.audioDraft(gesture, Math.round(delta));
        if (gesture.edge === "start" && delta === 0)
            return;
        const frames = totalFrames(this.project);
        const boundaries = [0];
        for (const scene of this.project.scenes)
            boundaries.push(boundaries.at(-1) + scene.durationFrames);
        const sourceStart = gesture.edge === "start" ? this.audioSourceStartFrame(gesture.original) : undefined;
        if (sourceStart !== undefined)
            boundaries.push(sourceStart);
        const edges = gesture.edge ? [gesture.edge] : ["start", "end"];
        const candidates = edges.flatMap(edge => {
            const initial = edge === "start" ? gesture.original.startFrame : this.displayAudioEnd(gesture.original, frames);
            return boundaries.map(frame => ({ edge, frame, delta: frame - initial, distance: Math.abs(initial + delta - frame) * gesture.scale }));
        }).filter(candidate => candidate.distance <= 8).sort((a, b) => a.distance - b.distance);
        for (const candidate of candidates) {
            let snapped = this.audioDraft(gesture, candidate.delta);
            const boundary = candidate.edge === "start" ? snapped.startFrame : this.displayAudioEnd(snapped, frames);
            // Snapping never overrides the source duration or timeline limits.
            if (boundary !== candidate.frame || !gesture.edge && snapped.startFrame !== gesture.original.startFrame + candidate.delta)
                continue;
            if (candidate.frame === sourceStart && delta < 0 && snapped.kind === "file")
                snapped = { ...snapped, sourceOffsetSamples: 0 };
            gesture.draft = snapped;
            gesture.snapFrame = candidate.frame;
            break;
        }
    }
    audioPreview(gesture) {
        const draft = gesture.draft, end = this.displayAudioEnd(draft, totalFrames(this.project));
        let start = 0;
        const scenes = this.project.scenes.flatMap((scene, index) => {
            const left = start;
            start += scene.durationFrames;
            return draft.startFrame < start && end > left ? [index] : [];
        });
        const conflict = this.project.audioSegments.find(segment => segment.kind === "file" && segment.id !== draft.id && segment.startFrame < (draft.endFrame ?? Infinity) && (segment.endFrame ?? Infinity) > draft.startFrame);
        const label = scenes.length > 1 ? `Clips ${scenes[0] + 1}–${scenes.at(-1) + 1}` : scenes.length ? `Clip ${scenes[0] + 1}` : "Outside clips";
        return { scenes, conflict: !!conflict, message: conflict ? "Provided audio overlaps another audio file. Move or trim it before dropping." : `${label}${scenes.length ? " → Provided audio" : " — audio is outside the video"}` };
    }
    publishAudioPreview(message) {
        if (message === this.audioPreviewMessage)
            return;
        this.audioPreviewMessage = message;
        this.onAudioPreview(message);
    }
    beginResizeView(pointerX, boundary) {
        this.resizeView = { scale: this.pixelsPerFrame(), zoom: this.zoom, scroll: this.scrollOffset, pointerX, boundary, pan: 0, panned: false, towardEdge: false };
    }
    resizeDelta(gesture, pointerX) {
        const view = this.resizeView;
        return (pointerX - gesture.startX) / gesture.scale + (view?.panned ? view.pan / view.scale : 0);
    }
    updateResizeDraft(gesture, pointerX) {
        const delta = this.resizeDelta(gesture, pointerX);
        if (gesture.kind === "audio")
            this.updateAudioDraft(gesture, delta);
        else {
            // Legacy long scenes may be shortened gradually, but never extended further.
            const maximum = Math.max(gesture.initialFrames, this.project.fps * MAX_SCENE_SECONDS);
            const scene = this.project.scenes.find(row => row.id === gesture.sceneId);
            gesture.frames = Math.max(minSceneFrames(scene), Math.min(maximum, gesture.initialFrames + Math.round(delta)));
        }
        const view = this.resizeView;
        if (view?.panned) {
            const boundary = gesture.kind === "scene-resize" ? view.boundary + gesture.frames - gesture.initialFrames : audioEnd(gesture.draft, totalFrames(this.project));
            // Reveal the real handle without discarding any outward pointer movement.
            this.scrollOffset = Math.max(view.scroll + view.pan, boundary * view.scale - (this.canvas.clientWidth - 24));
        }
    }
    edgeScrollSpeed() {
        const view = this.resizeView, gesture = this.gesture;
        if (!view?.towardEdge || !gesture || gesture.kind !== "scene-resize" || !gesture.active)
            return 0;
        const rect = this.canvas.getBoundingClientRect(), graphScale = rect.width / this.canvas.clientWidth;
        if (graphScale <= 0)
            return 0;
        const edge = rect.right - 12 * graphScale, zone = Math.min(36, rect.width / 4);
        return Math.max(0, Math.min(1, (view.pointerX - edge + zone) / zone)) * 220 / graphScale;
    }
    stopEdgeScroll() {
        if (this.edgeScrollRequest !== undefined)
            window.cancelAnimationFrame(this.edgeScrollRequest);
        this.edgeScrollRequest = this.edgeScrollTime = undefined;
    }
    scheduleEdgeScroll() {
        if (!this.edgeScrollSpeed()) {
            this.stopEdgeScroll();
            return;
        }
        if (this.edgeScrollRequest === undefined)
            this.edgeScrollRequest = window.requestAnimationFrame(this.autoScrollResize);
    }
    autoScrollResize = (time) => {
        this.edgeScrollRequest = undefined;
        const gesture = this.gesture, view = this.resizeView, speed = this.edgeScrollSpeed();
        if (!speed || !view || !gesture || (gesture.kind !== "scene-resize" && gesture.kind !== "audio")) {
            this.stopEdgeScroll();
            return;
        }
        const elapsed = this.edgeScrollTime === undefined ? 0 : Math.min(50, Math.max(0, time - this.edgeScrollTime));
        this.edgeScrollTime = time;
        if (elapsed) {
            const frames = totalFrames(this.project);
            const maximum = gesture.kind === "scene-resize"
                ? Math.max(gesture.initialFrames, this.project.fps * MAX_SCENE_SECONDS)
                : audioEnd(this.audioDraft(gesture, this.horizonFrame()), frames);
            const current = gesture.kind === "scene-resize" ? gesture.frames : audioEnd(gesture.draft, frames);
            view.panned = true;
            if (current >= maximum) {
                this.updateResizeDraft(gesture, view.pointerX);
                this.draw();
                this.stopEdgeScroll();
                return;
            }
            view.pan += Math.min(speed * elapsed / 1000, (maximum - current) * view.scale);
            this.updateResizeDraft(gesture, view.pointerX);
            this.draw();
        }
        this.scheduleEdgeScroll();
    };
    pointerMove = (event) => {
        const gesture = this.gesture;
        if (!gesture) {
            if (!this.withinTimeline(event)) {
                this.canvas.style.cursor = "default";
                if (this.hoveredEdge) {
                    this.hoveredEdge = undefined;
                    this.draw();
                }
                return;
            }
            const audio = this.pointerAudio(event), scene = audio ? undefined : this.pointerResizeScene(event);
            const edge = audio?.edge ? { kind: "audio", id: audio.segment.id, edge: audio.edge } : scene ? { kind: "scene", id: scene.id, edge: "end" } : undefined;
            this.canvas.style.cursor = edge ? "ew-resize" : audio?.segment.kind === "generate" ? "pointer" : audio || this.pointerScene(event) ? "grab" : "crosshair";
            if (edge?.kind !== this.hoveredEdge?.kind || edge?.id !== this.hoveredEdge?.id || edge?.edge !== this.hoveredEdge?.edge) {
                this.hoveredEdge = edge;
                this.draw();
            }
            return;
        }
        if (gesture.pointerId !== event.pointerId)
            return;
        event.stopPropagation();
        if (gesture.kind === "seek") {
            this.onSeek(this.pointerFrame(event));
            return;
        }
        // Small timing corrections still count when graph zoom puts several frames inside five pixels.
        const threshold = gesture.kind === "audio" ? Math.min(5, Math.max(1, gesture.scale)) : 5;
        if (!gesture.active && Math.hypot(event.clientX - gesture.startX, event.clientY - gesture.startY) >= threshold) {
            gesture.active = true;
            if (gesture.kind === "audio")
                this.onAudioStart();
            else if (gesture.kind === "scene-resize")
                this.onResizeStart();
            else
                this.onReorderStart();
        }
        if (!gesture.active)
            return;
        if (this.resizeView) {
            if (event.clientX !== this.resizeView.pointerX)
                this.resizeView.towardEdge = event.clientX > this.resizeView.pointerX;
            this.resizeView.pointerX = event.clientX;
        }
        if (gesture.kind === "audio") {
            this.updateResizeDraft(gesture, event.clientX);
            this.canvas.style.cursor = this.audioPreview(gesture).conflict ? "not-allowed" : gesture.edge ? "ew-resize" : "grabbing";
        }
        else if (gesture.kind === "scene-resize") {
            this.updateResizeDraft(gesture, event.clientX);
            this.canvas.style.cursor = "ew-resize";
        }
        else {
            gesture.targetId = this.pointerScene(event);
            this.canvas.style.cursor = gesture.targetId ? "grabbing" : "not-allowed";
        }
        this.draw();
        this.scheduleEdgeScroll();
    };
    pointerLeave = () => {
        if (this.gesture || !this.hoveredEdge)
            return;
        this.hoveredEdge = undefined;
        this.canvas.style.cursor = "crosshair";
        this.draw();
    };
    finishGesture(keepView = false) {
        this.stopEdgeScroll();
        const view = this.resizeView;
        this.resizeView = undefined;
        if (view && !keepView) {
            this.zoom = view.zoom;
            this.scrollOffset = view.scroll;
        }
        const gesture = this.gesture;
        this.gesture = undefined;
        this.hoveredEdge = undefined;
        this.publishAudioPreview("");
        if (gesture && this.canvas.hasPointerCapture(gesture.pointerId))
            this.canvas.releasePointerCapture(gesture.pointerId);
        this.canvas.style.cursor = "crosshair";
        if (!keepView)
            this.draw();
        return gesture;
    }
    commitGesture(targetId) {
        const view = this.resizeView, previous = this.project;
        const preserveView = view && (view.panned || view.zoom < 1) && this.gesture && "active" in this.gesture && this.gesture.active;
        // Preserve the viewport reached while edge-scrolling when the edit commits.
        if (preserveView)
            this.committingView = { scale: view.scale, scroll: this.scrollOffset };
        const gesture = this.finishGesture(!!this.committingView);
        if (!gesture || gesture.kind === "seek" || !gesture.active)
            return;
        try {
            if (gesture.kind === "audio") {
                if (JSON.stringify(gesture.original) !== JSON.stringify(gesture.draft))
                    this.onAudioChange(gesture.draft, gesture.edge ?? "move");
            }
            else if (gesture.kind === "scene-resize") {
                if (gesture.frames !== gesture.initialFrames)
                    this.onResize(gesture.sceneId, gesture.frames);
            }
            else {
                const target = targetId ?? gesture.targetId;
                if (target && target !== gesture.sceneId)
                    this.onReorder(gesture.sceneId, target);
            }
        }
        finally {
            this.committingView = undefined;
            if (preserveView && this.project === previous) {
                this.zoom = view.zoom;
                this.scrollOffset = view.scroll;
            }
            if (preserveView)
                this.draw();
        }
    }
    pointerUp = (event) => {
        if (this.gesture?.pointerId !== event.pointerId)
            return;
        event.stopPropagation();
        if (this.gesture.kind === "audio" || this.gesture.kind === "scene-resize")
            this.pointerMove(event);
        else if (this.gesture.kind === "scene")
            this.gesture.targetId = this.pointerScene(event);
        this.commitGesture();
    };
    pointerCancel = (event) => { if (this.gesture && (!event || event.pointerId === this.gesture.pointerId))
        this.finishGesture(); };
    doubleClick = (event) => {
        const id = this.pointerScene(event);
        if (!id || this.pointerResizeScene(event))
            return;
        event.preventDefault();
        event.stopPropagation();
        this.pointerCancel();
        this.onRename(id);
    };
    selectClip(destination) {
        const frames = totalFrames(this.project);
        const clips = [
            ...this.project.scenes.map((scene, index) => ({ id: scene.id, audio: false, start: sceneStartFrame(this.project, index), end: sceneStartFrame(this.project, index) + scene.durationFrames })),
            ...this.project.audioSegments.map(segment => ({ id: segment.id, audio: true, start: segment.startFrame, end: this.displayAudioEnd(segment, frames) })),
        ];
        const current = clips.findIndex(clip => clip.audio ? clip.id === this.selectedAudioId : !this.selectedAudioId && clip.id === this.selectedId);
        const index = destination === "first" ? 0 : destination === "last" ? clips.length - 1 : Math.max(0, Math.min(clips.length - 1, current < 0 ? 0 : current + destination));
        const clip = clips[index];
        if (!clip)
            return;
        this.pointerCancel();
        if (clip.audio) {
            if (this.onAudioSelect(clip.id) === false)
                return;
            this.selectedAudioId = clip.id;
        }
        else {
            if (this.onSelect(clip.id) === false)
                return;
            this.selectedId = clip.id;
            this.selectedAudioId = "";
        }
        if (clip.start < totalFrames(this.project))
            this.onSeek(clip.start);
        this.revealRange(clip.start, clip.end);
        this.draw();
    }
    keyDown = (event) => {
        if (event.isComposing)
            return;
        if (event.altKey && ["ArrowLeft", "ArrowRight", "Home", "End"].includes(event.key)) {
            event.preventDefault();
            event.stopPropagation();
            this.selectClip(event.key === "Home" ? "first" : event.key === "End" ? "last" : event.key === "ArrowLeft" ? -1 : 1);
            return;
        }
        if ((event.key === "F2" || event.key === "Enter") && !this.selectedAudioId && this.project.scenes.some(scene => scene.id === this.selectedId)) {
            event.preventDefault();
            event.stopPropagation();
            this.pointerCancel();
            this.onRename(this.selectedId);
            return;
        }
        if (event.key === "Escape") {
            if (this.gesture) {
                event.preventDefault();
                event.stopPropagation();
            }
            this.pointerCancel();
            return;
        }
        if (event.key === "Delete" || event.key === "Backspace") {
            if (event.altKey || event.ctrlKey || event.metaKey || event.shiftKey || event.isComposing)
                return;
            event.preventDefault();
            event.stopPropagation();
            this.pointerCancel();
            if (this.selectedAudioId) {
                if (this.project.audioSegments.some(segment => segment.id === this.selectedAudioId))
                    this.onAudioRemove();
            }
            else if (this.project.scenes.some(scene => scene.id === this.selectedId))
                this.onSceneRemove();
            return;
        }
        if (event.ctrlKey || event.metaKey || event.altKey)
            return;
        if (event.key === "ArrowLeft" || event.key === "ArrowRight") {
            event.preventDefault();
            event.stopPropagation();
            this.onSeek(this.frame + (event.key === "ArrowRight" ? 1 : -1) * (event.shiftKey ? this.project.fps : 1));
        }
        if (event.key === "Home" || event.key === "End") {
            event.preventDefault();
            event.stopPropagation();
            this.onSeek(event.key === "Home" ? 0 : totalFrames(this.project));
        }
    };
    dragOver = (event) => {
        const y = this.localPoint(event).y;
        if (!event.dataTransfer?.types.includes("Files") || y < 96 || y > 150) {
            this.dragLeave();
            return;
        }
        if (!this.withinTimeline(event)) {
            event.preventDefault();
            event.stopPropagation();
            event.dataTransfer.dropEffect = "none";
            this.dragLeave();
            return;
        }
        event.preventDefault();
        event.stopPropagation();
        event.dataTransfer.dropEffect = "copy";
        this.canvas.classList?.add("drag-over");
    };
    dragLeave = () => { this.canvas.classList?.remove("drag-over"); };
    drop = (event) => {
        const y = this.localPoint(event).y;
        this.dragLeave();
        if (!event.dataTransfer?.files.length || y < 96 || y > 150)
            return;
        event.preventDefault();
        event.stopPropagation();
        if (this.withinTimeline(event))
            this.onAudioDrop(event.dataTransfer.files, this.pointerFrame(event));
    };
    draw() {
        if (this.disposed)
            return;
        const width = this.canvas.clientWidth, renderedHeight = this.canvas.clientHeight || TIMELINE_HEIGHT;
        const trackScale = this.trackScale(), height = renderedHeight / trackScale;
        this.syncScroll();
        this.syncThumbnails();
        if (!width) {
            this.onLayoutChange();
            return;
        }
        this.onLayoutChange();
        const selectedAudio = this.project.audioSegments.findIndex(segment => segment.id === this.selectedAudioId);
        const selectedScene = this.project.scenes.findIndex(scene => scene.id === this.selectedId);
        const audio = this.project.audioSegments[selectedAudio];
        const selection = audio ? `${audio.kind === "file" ? audio.name ?? audio.asset.filename : "Generate audio"}, audio ${selectedAudio + 1} of ${this.project.audioSegments.length}`
            : selectedScene >= 0 ? `${sceneName(this.project.scenes[selectedScene], selectedScene)}, clip ${selectedScene + 1} of ${this.project.scenes.length}` : "No clip selected";
        this.canvas.setAttribute("aria-valuetext", `${selection}; frame ${this.frame}`);
        const ratio = window.devicePixelRatio || 1;
        this.canvas.width = Math.round(width * ratio);
        this.canvas.height = Math.round(renderedHeight * ratio);
        const context = this.canvas.getContext("2d");
        if (!context)
            return;
        context.scale(ratio, ratio * trackScale);
        // The compact layout can tighten track spacing, while labels keep their CSS
        // font size. Extra panel height remains empty instead of stretching tracks.
        const drawText = (text, left, baseline) => {
            context.save();
            context.scale(1, 1 / trackScale);
            context.fillText(text, left, baseline * trackScale);
            context.restore();
        };
        const gesture = this.gesture, resizing = gesture?.kind === "scene-resize" && gesture.active ? gesture : undefined;
        const editingAudio = gesture?.kind === "audio" && gesture.active ? gesture : undefined;
        const audioPreview = editingAudio ? this.audioPreview(editingAudio) : undefined;
        this.publishAudioPreview(audioPreview?.message ?? "");
        let project = resizing ? { ...this.project, scenes: this.project.scenes.map(scene => scene.id === resizing.sceneId ? { ...scene, durationFrames: resizing.frames } : scene) } : this.project;
        const frames = totalFrames(project);
        this.canvas.setAttribute("aria-valuemax", String(frames));
        const scale = this.pixelsPerFrame(), x = (frame) => 12 + frame * scale - this.scrollOffset;
        const style = getComputedStyle(this.canvas), color = (property, fallback) => style.getPropertyValue(property).trim() || fallback;
        const colors = { background: color("--canvas-bg", "#0b090a"), track: color("--track", "#2b292d"), selected: color("--selection", "#631f2c"), focus: color("--selection-border", "#ff6b7b"), conflict: color("--error", "#ff7878"), text: color("--text", "#fff6f6"), muted: color("--muted", "#c6bec4"), waveform: color("--waveform", "#e795a2"), playhead: color("--playhead", "#fff6f6") };
        context.fillStyle = colors.background;
        context.fillRect(0, 0, width, height);
        const horizon = this.horizonFrame(), right = this.activeRight();
        context.save();
        context.beginPath();
        context.rect(12, 0, Math.max(0, right - 12), height);
        context.clip();
        const outside = Math.max(12, x(frames));
        if (outside < right - .01) {
            context.fillStyle = colors.track;
            context.globalAlpha = .35;
            context.fillRect(outside, 24, right - outside, 127);
            context.globalAlpha = 1;
        }
        const fps = this.project.fps, lastFrame = Math.min(horizon, (this.scrollOffset + width - 24) / scale);
        const timeLabel = (frame) => `${Number((frame / fps).toFixed(2))}s`;
        // The ruler only draws the visible time range, including empty space.
        // The exact endpoint is separate from the nice tick interval, so it never
        // disappears merely because its label would extend outside the viewport.
        const tickSpacing = Math.max(88, timeLabel(lastFrame).length * 8 + 20);
        const niceStep = (minimum) => {
            const magnitude = 10 ** Math.floor(Math.log10(minimum));
            return [1, 2, 5, 10].map(value => value * magnitude).find(value => value >= minimum) ?? magnitude * 10;
        };
        this.canvas.setAttribute("aria-description", "Ruler shows seconds (s), with up to two decimal places when zoomed in. Left and right arrows move one frame; Shift moves one second.");
        // Use readable second intervals (1, .5, .2, .1…), independent of FPS.
        // Only use individual frames once each has enough room for its own label.
        const tickStep = scale >= tickSpacing ? 1 : niceStep(tickSpacing / (scale * fps)) * fps;
        const firstFrame = Math.ceil(this.scrollOffset / (scale * tickStep)) * tickStep;
        context.font = "13px ui-monospace, monospace";
        const terminalX = x(horizon), terminalVisible = terminalX >= 12 && terminalX <= width - 12 + .01;
        const terminalLabel = timeLabel(horizon), terminalWidth = context.measureText(terminalLabel).width;
        const terminalLeft = Math.max(15, terminalX - terminalWidth - 3);
        const labelsEnd = terminalVisible ? terminalLeft - 12 : right;
        for (let frame = firstFrame; frame <= lastFrame; frame += tickStep) {
            const label = timeLabel(frame), left = x(frame);
            if ((!terminalVisible || frame !== horizon) && left + 3 + context.measureText(label).width <= labelsEnd) {
                context.fillStyle = colors.muted;
                drawText(label, left + 3, 17);
            }
            context.fillStyle = colors.track;
            context.fillRect(left, 24, 1, 127);
        }
        if (terminalVisible) {
            context.fillStyle = colors.muted;
            drawText(terminalLabel, terminalLeft, 17);
            context.fillStyle = colors.track;
            context.fillRect(terminalX - 1, 24, 1, 127);
        }
        project.scenes.forEach((scene, index) => {
            const left = x(sceneStartFrame(project, index)), blockWidth = Math.max(1, scene.durationFrames * scale - 3);
            if (left + blockWidth < 12 || left > width - 12)
                return;
            context.fillStyle = scene.id === this.selectedId && !this.selectedAudioId ? colors.selected : colors.track;
            context.beginPath();
            context.roundRect(left, 36, Math.max(1, blockWidth), 50, 5);
            context.fill();
            const covered = audioPreview?.scenes.includes(index);
            if (covered) {
                context.fillStyle = audioPreview?.conflict ? colors.conflict : colors.focus;
                context.globalAlpha = .16;
                context.fill();
                context.globalAlpha = 1;
            }
            if (covered || scene.id === this.selectedId && !this.selectedAudioId) {
                context.strokeStyle = covered && audioPreview?.conflict ? colors.conflict : colors.focus;
                context.lineWidth = 2;
                context.stroke();
                context.lineWidth = 1;
            }
            const visibleLeft = Math.max(left, 12), visibleRight = Math.min(left + blockWidth, width - 12);
            // Keep text clear of the trim target. The last-frame
            // image reaches the clip edge, with the resize grip painted over it below.
            const endInset = left + blockWidth <= width - 12 ? Math.min(this.screenPixels(20), blockWidth * .35) + 4 : 8;
            const contentLeft = visibleLeft + 8, contentRight = Math.max(contentLeft, visibleRight - endInset);
            const thumbnailRight = scene.endImage ? Math.max(contentLeft, visibleRight) : contentRight;
            let labelLeft = contentLeft, labelRight = contentRight;
            const thumbnailLimit = Math.max(0, (thumbnailRight - contentLeft - (scene.image && scene.endImage ? 8 : 0)) / (scene.image && scene.endImage ? 2 : 1));
            for (const reference of [{ asset: scene.image, crop: scene.crop, end: false }, { asset: scene.endImage, crop: scene.endCrop, end: true }]) {
                const thumbnail = reference.asset ? this.thumbnails.get(assetUrl(reference.asset)) : undefined;
                if (!thumbnail?.ready || thumbnailLimit < 8)
                    continue;
                const crop = positionedCrop(thumbnail.image.naturalWidth, thumbnail.image.naturalHeight, project.width, project.height, reference.crop);
                if (!crop)
                    continue;
                const thumbnailWidth = Math.min(88, 42 * trackScale * project.width / project.height, thumbnailLimit), thumbnailHeight = thumbnailWidth * project.height / project.width / trackScale;
                const thumbnailLeft = reference.end ? thumbnailRight - thumbnailWidth : contentLeft;
                context.save();
                context.beginPath();
                context.rect(contentLeft, 40, Math.max(0, thumbnailRight - contentLeft), 42);
                context.clip();
                context.drawImage(thumbnail.image, crop.x, crop.y, crop.width, crop.height, thumbnailLeft, 40 + (42 - thumbnailHeight) / 2, thumbnailWidth, thumbnailHeight);
                context.restore();
                if (reference.end)
                    labelRight = Math.min(labelRight, thumbnailLeft - 8);
                else
                    labelLeft += thumbnailWidth + 8;
            }
            const labelWidth = labelRight - labelLeft;
            if (labelWidth > 14) {
                context.save();
                context.beginPath();
                context.rect(labelLeft, 36, labelWidth, 50);
                context.clip();
                context.fillStyle = colors.text;
                context.font = "600 14px system-ui, sans-serif";
                drawText(sceneName(scene, index), labelLeft, 56);
                context.fillStyle = colors.muted;
                context.font = "13px system-ui, sans-serif";
                drawText(covered ? audioPreview?.conflict ? "Audio overlap" : "→ Provided audio" : resizing && scene.id === resizing.sceneId ? `${(scene.durationFrames / project.fps).toFixed(1)} s` : scene.prompt, labelLeft, 74);
                context.restore();
            }
            if (blockWidth > 2) {
                const active = this.hoveredEdge?.kind === "scene" && this.hoveredEdge.id === scene.id || gesture?.kind === "scene-resize" && gesture.sceneId === scene.id;
                if (active) {
                    const targetWidth = Math.min(this.screenPixels(20), blockWidth * .35);
                    context.fillStyle = colors.focus;
                    context.globalAlpha = .22;
                    context.fillRect(left + blockWidth - targetWidth, 36, targetWidth, 50);
                    context.globalAlpha = 1;
                }
                // Keep painted grips in canvas pixels: Comfy can transform this bitmap without a redraw.
                const gripWidth = Math.min(6, blockWidth * .2), inset = Math.min(1, blockWidth * .1);
                context.fillStyle = active ? colors.focus : colors.muted;
                context.fillRect(left + blockWidth - gripWidth - inset, 44, gripWidth, 34);
            }
        });
        if (gesture?.kind === "scene" && gesture.active && gesture.targetId && gesture.targetId !== gesture.sceneId) {
            const source = this.project.scenes.findIndex(scene => scene.id === gesture.sceneId), target = this.project.scenes.findIndex(scene => scene.id === gesture.targetId);
            if (source >= 0 && target >= 0) {
                const insertAt = sceneStartFrame(this.project, target) + (source < target ? this.project.scenes[target].durationFrames : 0);
                context.fillStyle = colors.focus;
                context.fillRect(x(insertAt) - 2, 32, 3, 58);
            }
        }
        // A file stays one continuous block across cuts. Preview removes generated
        // audio for every touched clip, while other files remain visible as conflicts.
        const segments = this.project.audioSegments.flatMap(segment => {
            if (segment.id === editingAudio?.original.id)
                return [];
            let parts = [segment];
            if (segment.kind === "generate" && audioPreview)
                for (const index of audioPreview.scenes) {
                    const start = sceneStartFrame(project, index), end = start + project.scenes[index].durationFrames;
                    parts = parts.flatMap(part => {
                        const finish = this.displayAudioEnd(part, frames);
                        if (part.startFrame >= end || finish <= start)
                            return [part];
                        return [...(part.startFrame < start ? [{ ...part, endFrame: start }] : []), ...(finish > end ? [{ ...part, startFrame: end }] : [])];
                    });
                }
            return parts;
        });
        if (editingAudio)
            segments.push(editingAudio.draft);
        let visible = false;
        const drawAudio = (segment) => {
            const end = this.displayAudioEnd(segment, frames);
            const left = x(segment.startFrame), blockWidth = Math.max(1, (end - segment.startFrame) * scale - 2);
            if (left + blockWidth < 12 || left > width - 12)
                return;
            visible = true;
            context.fillStyle = segment.id === this.selectedAudioId ? colors.selected : colors.track;
            context.fillRect(left, 101, blockWidth, 38);
            context.save();
            context.beginPath();
            context.rect(left, 101, blockWidth, 38);
            context.clip();
            if (segment.kind === "file") {
                const waveform = this.waveforms.get(assetUrl(segment.asset));
                if (waveform) {
                    context.fillStyle = colors.waveform;
                    for (let px = Math.max(left, 12); px < Math.min(x(end), width - 12); px += 2) {
                        const absoluteFrame = Math.max(segment.startFrame, (px - 12 + this.scrollOffset) / scale);
                        const sourceSeconds = segment.sourceOffsetSamples / 48000 + (absoluteFrame - segment.startFrame) / this.project.fps;
                        if (sourceSeconds >= waveform.duration)
                            break;
                        const index = Math.floor(sourceSeconds / waveform.duration * waveform.peaks.length), amplitude = (waveform.peaks[index] ?? 0) * 12;
                        context.fillRect(px, 123 - Math.max(1, amplitude), 1, Math.max(2, amplitude * 2));
                    }
                }
            }
            else {
                context.strokeStyle = colors.muted;
                context.globalAlpha = .14;
                for (let line = Math.max(left, 12) - 40; line < Math.min(left + blockWidth, width - 12); line += 12) {
                    context.beginPath();
                    context.moveTo(line, 139);
                    context.lineTo(line + 38, 101);
                    context.stroke();
                }
                context.globalAlpha = 1;
            }
            if (end > frames) {
                context.fillStyle = colors.background;
                context.globalAlpha = .45;
                context.fillRect(Math.max(left, x(frames)), 101, Math.max(0, x(end) - Math.max(left, x(frames))), 38);
                context.globalAlpha = 1;
            }
            const labelLeft = Math.max(left, 12) + 12, labelWidth = Math.max(0, Math.min(left + blockWidth, width - 12) - labelLeft - 12);
            context.save();
            context.beginPath();
            context.rect(labelLeft, 101, labelWidth, 38);
            context.clip();
            if (labelWidth > 14) {
                context.fillStyle = colors.text;
                context.font = "600 14px system-ui, sans-serif";
                drawText(segment.kind === "generate" ? "✧ Generate audio" : segment.name ?? segment.asset.filename, labelLeft, 117);
            }
            if (editingAudio && segment.id === editingAudio.original.id && blockWidth > 30) {
                const destination = editingAudio.draft;
                context.fillStyle = colors.text;
                context.font = "13px ui-monospace, monospace";
                drawText(`${Number((destination.startFrame / fps).toFixed(2))}–${timeLabel(this.displayAudioEnd(destination, frames))}`, labelLeft, 134);
            }
            context.restore();
            context.restore();
            if (segment.id === this.selectedAudioId || segment.id === editingAudio?.original.id) {
                context.strokeStyle = segment.id === editingAudio?.original.id && audioPreview?.conflict ? colors.conflict : colors.focus;
                context.lineWidth = 2;
                context.strokeRect(left + 1, 102, Math.max(0, blockWidth - 2), 36);
                context.lineWidth = 1;
            }
            if (segment.kind === "file" && blockWidth > 2) {
                const edge = gesture?.kind === "audio" && gesture.original.id === segment.id ? gesture.edge
                    : this.hoveredEdge?.kind === "audio" && this.hoveredEdge.id === segment.id ? this.hoveredEdge.edge : undefined;
                if (edge) {
                    const targetWidth = Math.min(this.screenPixels(20), blockWidth * .3);
                    context.fillStyle = colors.focus;
                    context.globalAlpha = .22;
                    context.fillRect(edge === "start" ? left : left + blockWidth - targetWidth, 101, targetWidth, 38);
                    context.globalAlpha = 1;
                }
                const gripWidth = Math.min(5, blockWidth * .15), inset = Math.min(3, blockWidth * .1);
                if (left >= 12) {
                    context.fillStyle = edge === "start" ? colors.focus : colors.muted;
                    context.fillRect(left + inset, 112, gripWidth, 23);
                }
                if (left + blockWidth <= width - 12 && audioEnd(segment, frames) > segment.startFrame) {
                    context.fillStyle = edge === "end" ? colors.focus : colors.muted;
                    context.fillRect(left + blockWidth - gripWidth - inset, 112, gripWidth, 23);
                }
            }
        };
        for (const segment of segments)
            drawAudio(segment);
        if (!visible) {
            context.fillStyle = colors.muted;
            context.font = "13px system-ui, sans-serif";
            drawText(segments.length ? "No audio in this view" : "No audio — empty space is silent", 20, 122);
        }
        if (editingAudio && !editingAudio.edge) {
            context.fillStyle = audioPreview?.conflict ? colors.conflict : colors.focus;
            context.fillRect(x(editingAudio.draft.startFrame) - 2, 98, 3, 44);
        }
        if (gesture?.kind === "audio" && gesture.active && gesture.snapFrame !== undefined) {
            context.fillStyle = colors.focus;
            context.fillRect(x(gesture.snapFrame) - 1, 28, 2, 116);
        }
        context.fillStyle = colors.playhead;
        const playhead = x(Math.min(this.frame, frames));
        context.fillRect(playhead - .5, 24, 1, 122);
        context.beginPath();
        context.moveTo(playhead - 4, 24);
        context.lineTo(playhead + 4, 24);
        context.lineTo(playhead, 30);
        context.closePath();
        context.fill();
        context.restore();
    }
    dispose() {
        this.disposed = true;
        for (const { image } of this.thumbnails.values())
            image.onload = image.onerror = null;
        this.thumbnails.clear();
        this.observer.disconnect();
        this.pointerCancel();
        this.canvas.removeEventListener("wheel", this.wheel);
        this.scrollbar?.removeEventListener("scroll", this.scroll);
        this.scrollbar?.removeEventListener("keydown", this.scrollKeyDown);
        this.canvas.removeEventListener("pointerdown", this.pointerDown);
        this.canvas.removeEventListener("pointermove", this.pointerMove);
        this.canvas.removeEventListener("pointerleave", this.pointerLeave);
        this.canvas.removeEventListener("pointerup", this.pointerUp);
        this.canvas.removeEventListener("pointercancel", this.pointerCancel);
        this.canvas.removeEventListener("lostpointercapture", this.pointerCancel);
        this.canvas.removeEventListener("keydown", this.keyDown);
        this.canvas.removeEventListener("dblclick", this.doubleClick);
        this.canvas.removeEventListener("dragover", this.dragOver);
        this.canvas.removeEventListener("dragleave", this.dragLeave);
        this.canvas.removeEventListener("drop", this.drop);
    }
}
//# sourceMappingURL=timeline.js.map