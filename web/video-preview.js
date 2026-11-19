import { assetUrl, sceneAtFrame, totalFrames } from "./domain.js";
/** Browser-native decoding and audio; the timeline remains the single transport clock. */
export class VideoPreview {
    video;
    source = "";
    version = 0;
    playing = false;
    desiredTime = 0;
    pending = false;
    onError = () => { };
    constructor(video) {
        this.video = video;
        video.playsInline = true;
        video.preload = "auto";
        video.addEventListener("loadedmetadata", this.ready);
        video.addEventListener("error", this.failed);
    }
    ready = () => { this.seek(); if (this.playing)
        this.play(); };
    failed = () => { if (this.source)
        this.onError(new Error("This video could not be played. Check that its file is available and browser-compatible.")); };
    seek() {
        if (this.video.readyState < 1)
            return;
        if (Math.abs(this.video.currentTime - this.desiredTime) > (this.playing ? .15 : .002))
            this.video.currentTime = this.desiredTime;
    }
    play() {
        if (!this.video.paused || this.pending)
            return;
        const version = this.version;
        this.pending = true;
        void this.video.play().catch(error => {
            if (version === this.version && this.playing && error?.name !== "AbortError")
                this.onError(new Error("Video playback was blocked. Press Play to try again."));
        }).finally(() => { if (version === this.version)
            this.pending = false; });
    }
    sync(project, frame, playing) {
        const active = sceneAtFrame(project, Math.min(frame, totalFrames(project) - 1)), clip = active?.scene.video;
        const source = clip ? assetUrl(clip.asset) : "";
        this.playing = playing && Boolean(clip);
        if (source !== this.source) {
            this.version++;
            this.pending = false;
            this.video.pause();
            this.source = source;
            if (source)
                this.video.src = source;
            else {
                this.video.removeAttribute("src");
                this.video.load();
            }
        }
        this.video.hidden = !clip;
        if (!clip || !active)
            return false;
        this.desiredTime = clip.sourceStartFrame / clip.fps + Math.max(0, Math.min(frame - active.startFrame, active.scene.durationFrames - 1)) / project.fps;
        this.video.muted = !clip.hasAudio;
        this.video.playbackRate = 1;
        this.seek();
        if (this.playing)
            this.play();
        else
            this.video.pause();
        return true;
    }
    dispose() {
        this.version++;
        this.playing = false;
        this.source = "";
        this.video.pause();
        this.video.removeEventListener("loadedmetadata", this.ready);
        this.video.removeEventListener("error", this.failed);
        this.video.removeAttribute("src");
        this.video.load();
    }
}
