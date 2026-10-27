import { type Asset, type Project, assetUrl, totalFrames } from "./domain.js";
import { AUDIO_SAMPLE_RATE as SAMPLE_RATE, audioEnd, frameToSample } from "./audio.js";

export type AudioWaveform = { peaks: Float32Array; duration: number };
type DecodedAudio = AudioWaveform & { buffer: AudioBuffer };

/** One clock drives every uploaded clip. Generated regions stay silent in the storyboard. */
export class Playback {
  private context?: AudioContext;
  private buffers = new Map<string, DecodedAudio>();
  private loading = new Map<string, Promise<DecodedAudio>>();
  private sources = new Set<AudioBufferSourceNode>();
  private project: Project;
  private position = 0;
  private startedAt = 0;
  private startFrame = 0;
  private animation = 0;
  private active = false;
  private loadVersion = 0;
  private playVersion = 0;
  private pendingPlay = false;
  private disposed = false;
  onFrame: (frame: number, playing: boolean) => void = () => {};
  onWaveforms: (waveforms: ReadonlyMap<string, AudioWaveform>) => void = () => {};
  onError: (error: unknown) => void = () => {};

  constructor(project: Project) { this.project = project; }
  get frame(): number {
    if (!this.active) return this.position;
    return Math.min(totalFrames(this.project), this.startFrame + Math.floor((this.now() - this.startedAt) * this.project.fps));
  }
  get playing(): boolean { return this.active; }
  audioDuration(asset: Asset): number { return this.buffers.get(assetUrl(asset))?.duration ?? 0; }
  private now(): number { return this.context?.currentTime ?? performance.now() / 1000; }
  private assetKeys(): Set<string> {
    return new Set(this.project.audioSegments.flatMap(segment => segment.kind === "file" ? [assetUrl(segment.asset)] : []));
  }
  private publishWaveforms(): void {
    this.onWaveforms(new Map([...this.buffers].map(([url, { peaks, duration }]) => [url, { peaks, duration }])));
  }
  configure(project: Project): void {
    if (this.disposed) return;
    this.stop();
    const previous = this.assetKeys();
    this.project = project;
    const keys = this.assetKeys();
    if (previous.size !== keys.size || [...keys].some(key => !previous.has(key))) this.loadVersion++;
    let changed = false;
    for (const key of this.buffers.keys()) if (!keys.has(key)) { this.buffers.delete(key); changed = true; }
    for (const key of this.loading.keys()) if (!keys.has(key)) this.loading.delete(key);
    if (changed) this.publishWaveforms();
    this.position = Math.min(this.position, totalFrames(project));
    this.onFrame(this.position, false);
  }
  private audioContext(): AudioContext {
    if (!this.context) {
      // Preserve a silent player's clock if a source is prepared while it runs.
      const frame = this.frame;
      this.context = new AudioContext({ sampleRate: SAMPLE_RATE });
      if (this.active) { this.startFrame = frame; this.startedAt = this.context.currentTime; }
    }
    return this.context;
  }
  /** Decode before publishing the upload or changing its existing clip. */
  async prepareAudio(url: string): Promise<AudioBuffer> {
    if (this.disposed) throw new Error("The audio player has been disposed.");
    const context = this.audioContext();
    const response = await fetch(url);
    if (!response.ok) throw new Error("Could not load the audio file.");
    const data = await response.arrayBuffer();
    if (this.disposed) throw new Error("The audio player has been disposed.");
    const decoded = await context.decodeAudioData(data);
    if (this.disposed) throw new Error("The audio player has been disposed.");
    return decoded;
  }
  private summarize(buffer: AudioBuffer): DecodedAudio {
    const buckets = Math.min(2400, buffer.length);
    const peaks = new Float32Array(buckets);
    // Retain peaks in either channel, including right-only stereo recordings.
    for (let channel = 0; channel < (buffer.numberOfChannels ?? 1); channel++) {
      const samples = buffer.getChannelData(channel);
      for (let i = 0; i < buckets; i++) {
        const end = Math.floor((i + 1) * samples.length / buckets);
        let peak = peaks[i]!;
        for (let j = Math.floor(i * samples.length / buckets); j < end; j++) peak = Math.max(peak, Math.abs(samples[j]!));
        peaks[i] = peak;
      }
    }
    return { buffer, peaks, duration: buffer.duration };
  }
  /** Load distinct referenced sources as one publication; failed loads preserve valid cached media. */
  async loadAudioAssets(prepared?: { url: string; buffer: AudioBuffer }): Promise<void> {
    if (this.disposed) return;
    const version = ++this.loadVersion;
    const keys = [...this.assetKeys()];
    if (keys.some(key => !this.buffers.has(key)) || (prepared && keys.includes(prepared.url))) this.pause();
    let entries: [string, DecodedAudio][];
    try {
      if (keys.length) this.audioContext();
      entries = await Promise.all(keys.map(async (key): Promise<[string, DecodedAudio]> => {
        if (prepared?.url === key) return [key, this.summarize(prepared.buffer)];
        const cached = this.buffers.get(key);
        if (cached) return [key, cached];
        let pending = this.loading.get(key);
        if (!pending) {
          pending = this.prepareAudio(key).then(buffer => this.summarize(buffer));
          this.loading.set(key, pending);
          // Both branches remove only their own pending operation, even after replacement.
          const clear = () => { if (this.loading.get(key) === pending) this.loading.delete(key); };
          void pending.then(clear, clear);
        }
        return [key, await pending];
      }));
    } catch (error) {
      if (version !== this.loadVersion || this.disposed) return;
      throw error;
    }
    if (version !== this.loadVersion || this.disposed) return;
    this.buffers = new Map(entries);
    this.publishWaveforms();
  }
  async play(): Promise<void> {
    if (this.active || this.pendingPlay || this.disposed) return;
    const version = ++this.playVersion;
    this.pendingPlay = true;
    if (this.position >= totalFrames(this.project)) this.position = 0;
    try { if (this.context) await this.context.resume(); }
    catch (error) {
      if (this.disposed || version !== this.playVersion) return;
      this.pendingPlay = false;
      throw error;
    }
    if (this.disposed || version !== this.playVersion) return;
    this.pendingPlay = false;
    this.startFrame = this.position;
    this.startedAt = this.now();
    this.active = true;
    try {
      if (this.context) {
        const total = totalFrames(this.project), fps = this.project.fps;
        const positionSample = frameToSample(this.position, fps);
        for (const segment of this.project.audioSegments) {
          if (segment.kind !== "file") continue;
          const decoded = this.buffers.get(assetUrl(segment.asset));
          if (!decoded) continue;
          const start = frameToSample(Math.max(this.position, segment.startFrame), fps);
          const end = frameToSample(Math.min(total, audioEnd(segment, total)), fps);
          const offset = segment.sourceOffsetSamples + start - frameToSample(segment.startFrame, fps);
          const count = Math.min(end - start, Math.round(decoded.duration * SAMPLE_RATE) - offset);
          if (count <= 0) continue;
          const source = this.context.createBufferSource();
          this.sources.add(source);
          source.buffer = decoded.buffer;
          source.connect(this.context.destination);
          source.onended = () => { source.disconnect(); this.sources.delete(source); };
          source.start(this.startedAt + (start - positionSample) / SAMPLE_RATE, offset / SAMPLE_RATE, count / SAMPLE_RATE);
        }
      }
    } catch (error) {
      this.pause();
      throw error;
    }
    this.tick();
  }
  private stop(): void {
    this.playVersion++;
    this.pendingPlay = false;
    this.position = this.frame;
    this.active = false;
    cancelAnimationFrame(this.animation);
    for (const source of this.sources) {
      source.onended = null;
      try { source.stop(); } catch { /* A scheduled source may already have ended. */ }
      source.disconnect();
    }
    this.sources.clear();
  }
  pause(): void { this.stop(); this.onFrame(this.position, false); }
  seek(frame: number): void {
    const resume = this.active || this.pendingPlay;
    this.pause();
    this.position = Math.max(0, Math.min(totalFrames(this.project), Math.round(frame)));
    this.onFrame(this.position, false);
    if (resume) void this.play().catch(error => this.onError(error));
  }
  private tick = (): void => {
    if (!this.active) return;
    const frame = this.frame;
    if (frame >= totalFrames(this.project)) { this.pause(); return; }
    this.onFrame(frame, true);
    this.animation = requestAnimationFrame(this.tick);
  };
  dispose(): void {
    if (this.disposed) return;
    this.disposed = true;
    this.loadVersion++;
    this.pause();
    this.loading.clear();
    this.buffers.clear();
    if (this.context) void this.context.close().catch(() => { /* The host may already have closed the context. */ });
  }
}
