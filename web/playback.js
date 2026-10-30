import { assetUrl, totalFrames } from "./domain.js";
import { AUDIO_SAMPLE_RATE as SAMPLE_RATE } from "./audio.js";
/** Silent storyboard transport; audio decoding is used only for waveforms and timing. */
export class Playback {
    context;
    buffers = new Map();
    loading = new Map();
    project;
    position = 0;
    startedAt = 0;
    startFrame = 0;
    animation = 0;
    active = false;
    loadVersion = 0;
    disposed = false;
    onFrame = () => { };
    onWaveforms = () => { };
    onError = () => { };
    constructor(project) { this.project = project; }
    get frame() {
        if (!this.active)
            return this.position;
        return Math.min(totalFrames(this.project), this.startFrame + Math.floor((this.now() - this.startedAt) * this.project.fps));
    }
    get playing() { return this.active; }
    audioDuration(asset) { return this.buffers.get(assetUrl(asset))?.duration ?? 0; }
    now() { return performance.now() / 1000; }
    assetKeys() {
        return new Set(this.project.audioSegments.flatMap(segment => segment.kind === "file" ? [assetUrl(segment.asset)] : []));
    }
    publishWaveforms() {
        this.onWaveforms(new Map([...this.buffers].map(([url, { peaks, duration }]) => [url, { peaks, duration }])));
    }
    configure(project) {
        if (this.disposed)
            return;
        this.stop();
        const previous = this.assetKeys();
        this.project = project;
        const keys = this.assetKeys();
        if (previous.size !== keys.size || [...keys].some(key => !previous.has(key)))
            this.loadVersion++;
        let changed = false;
        for (const key of this.buffers.keys())
            if (!keys.has(key)) {
                this.buffers.delete(key);
                changed = true;
            }
        for (const key of this.loading.keys())
            if (!keys.has(key))
                this.loading.delete(key);
        if (changed)
            this.publishWaveforms();
        this.position = Math.min(this.position, totalFrames(project));
        this.onFrame(this.position, false);
    }
    audioContext() {
        // Decode uploaded files without creating an audio output device.
        return this.context ??= new OfflineAudioContext(2, 1, SAMPLE_RATE);
    }
    /** Decode before publishing the upload or changing its existing clip. */
    async prepareAudio(url) {
        if (this.disposed)
            throw new Error("The audio player has been disposed.");
        const context = this.audioContext();
        const response = await fetch(url);
        if (!response.ok)
            throw new Error("Could not load the audio file.");
        const data = await response.arrayBuffer();
        if (this.disposed)
            throw new Error("The audio player has been disposed.");
        const decoded = await context.decodeAudioData(data);
        if (this.disposed)
            throw new Error("The audio player has been disposed.");
        return decoded;
    }
    summarize(buffer) {
        const buckets = Math.min(2400, buffer.length);
        const peaks = new Float32Array(buckets);
        // Retain peaks in either channel, including right-only stereo recordings.
        for (let channel = 0; channel < (buffer.numberOfChannels ?? 1); channel++) {
            const samples = buffer.getChannelData(channel);
            for (let i = 0; i < buckets; i++) {
                const end = Math.floor((i + 1) * samples.length / buckets);
                let peak = peaks[i];
                for (let j = Math.floor(i * samples.length / buckets); j < end; j++)
                    peak = Math.max(peak, Math.abs(samples[j]));
                peaks[i] = peak;
            }
        }
        return { buffer, peaks, duration: buffer.duration };
    }
    /** Load distinct referenced sources as one publication; failed loads preserve valid cached media. */
    async loadAudioAssets(prepared) {
        if (this.disposed)
            return;
        const version = ++this.loadVersion;
        const keys = [...this.assetKeys()];
        if (keys.some(key => !this.buffers.has(key)) || (prepared && keys.includes(prepared.url)))
            this.pause();
        let entries;
        try {
            if (keys.length)
                this.audioContext();
            entries = await Promise.all(keys.map(async (key) => {
                if (prepared?.url === key)
                    return [key, this.summarize(prepared.buffer)];
                const cached = this.buffers.get(key);
                if (cached)
                    return [key, cached];
                let pending = this.loading.get(key);
                if (!pending) {
                    pending = this.prepareAudio(key).then(buffer => this.summarize(buffer));
                    this.loading.set(key, pending);
                    // Both branches remove only their own pending operation, even after replacement.
                    const clear = () => { if (this.loading.get(key) === pending)
                        this.loading.delete(key); };
                    void pending.then(clear, clear);
                }
                return [key, await pending];
            }));
        }
        catch (error) {
            if (version !== this.loadVersion || this.disposed)
                return;
            throw error;
        }
        if (version !== this.loadVersion || this.disposed)
            return;
        this.buffers = new Map(entries);
        this.publishWaveforms();
    }
    async play() {
        if (this.active || this.disposed)
            return;
        if (this.position >= totalFrames(this.project))
            this.position = 0;
        this.startFrame = this.position;
        this.startedAt = this.now();
        this.active = true;
        this.tick();
    }
    stop() {
        this.position = this.frame;
        this.active = false;
        cancelAnimationFrame(this.animation);
    }
    pause() { this.stop(); this.onFrame(this.position, false); }
    seek(frame) {
        const resume = this.active;
        this.pause();
        this.position = Math.max(0, Math.min(totalFrames(this.project), Math.round(frame)));
        this.onFrame(this.position, false);
        if (resume)
            void this.play().catch(error => this.onError(error));
    }
    tick = () => {
        if (!this.active)
            return;
        const frame = this.frame;
        if (frame >= totalFrames(this.project)) {
            this.pause();
            return;
        }
        this.onFrame(frame, true);
        this.animation = requestAnimationFrame(this.tick);
    };
    dispose() {
        if (this.disposed)
            return;
        this.disposed = true;
        this.loadVersion++;
        this.pause();
        this.loading.clear();
        this.buffers.clear();
        this.context = undefined;
    }
}
//# sourceMappingURL=playback.js.map