import { assetUrl, sceneAtFrame, totalFrames, type Project } from "./domain.js";

/** Browser-native decoding and audio; the timeline remains the single transport clock. */
export class VideoPreview {
  private source = "";
  private version = 0;
  private playing = false;
  private desiredTime = 0;
  private pending = false;
  onError: (error: Error) => void = () => {};
  constructor(private video: HTMLVideoElement) {
    video.playsInline = true; video.preload = "auto";
    video.addEventListener("loadedmetadata", this.ready);
    video.addEventListener("error", this.failed);
  }
  private ready = (): void => { this.seek(); if (this.playing) this.play(); };
  private failed = (): void => { if (this.source) this.onError(new Error("This video could not be played. Check that its file is available and browser-compatible.")); };
  private seek(): void {
    if (this.video.readyState < 1) return;
    if (Math.abs(this.video.currentTime - this.desiredTime) > (this.playing ? .15 : .002)) this.video.currentTime = this.desiredTime;
  }
  private play(): void {
    if (!this.video.paused || this.pending) return;
    const version = this.version;
    this.pending = true;
    void this.video.play().catch(error => {
      if (version === this.version && this.playing && error?.name !== "AbortError") this.onError(new Error("Video playback was blocked. Press Play to try again."));
    }).finally(() => { if (version === this.version) this.pending = false; });
  }
  sync(project: Project, frame: number, playing: boolean): boolean {
    const active = sceneAtFrame(project, Math.min(frame, totalFrames(project) - 1)), clip = active?.scene.video;
    const source = clip ? assetUrl(clip.asset) : "";
    this.playing = playing && Boolean(clip);
    if (source !== this.source) {
      this.version++; this.pending = false; this.video.pause(); this.source = source;
      if (source) this.video.src = source;
      else { this.video.removeAttribute("src"); this.video.load(); }
    }
    this.video.hidden = !clip;
    if (!clip || !active) return false;
    this.desiredTime = clip.sourceStartFrame / clip.fps + Math.max(0, Math.min(frame - active.startFrame, active.scene.durationFrames - 1)) / project.fps;
    this.video.muted = !clip.hasAudio;
    this.video.playbackRate = 1;
    this.seek();
    if (this.playing) this.play(); else this.video.pause();
    return true;
  }
  dispose(): void {
    this.version++; this.playing = false; this.source = ""; this.video.pause();
    this.video.removeEventListener("loadedmetadata", this.ready); this.video.removeEventListener("error", this.failed);
    this.video.removeAttribute("src"); this.video.load();
  }
}
