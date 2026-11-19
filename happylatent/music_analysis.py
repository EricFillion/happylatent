"""Bounded, CPU-only measurements of actual audio for soundtrack placement.

The labels in this module describe signal energy, not musical meaning. Beat
times are detected onsets consistent with an estimated pulse, never an invented
grid through silence. No model, download, network access, or GPU is required.
Runtime callers pass the pinned binary handle returned by ``open_asset``.
"""
from __future__ import annotations

from contextlib import contextmanager
import math
import os
import stat
import time
import wave

from .project import ValidationError

VERSION = 1
MAX_SECONDS = 6 * 60 * 60
MAX_BYTES = 8 * 1024**3
MAX_ENERGY_POINTS = 1200
MAX_BEATS = 8192
MAX_ONSETS = 512
MAX_SECTIONS = 64
FRAME_SECONDS = 0.02
PROCESSING_TIMEOUT = 180


def _number(value, name, *, minimum=0, maximum=MAX_SECONDS):
    if type(value) not in (int, float) or not math.isfinite(value) or not minimum <= value <= maximum:
        raise ValidationError(f"{name} must be a finite number between {minimum} and {maximum}.")
    return float(value)


@contextmanager
def _source(source):
    owned = not hasattr(source, "read")
    raw = None
    try:
        if owned:
            descriptor = os.open(source, os.O_RDONLY | getattr(os, "O_NONBLOCK", 0) | getattr(os, "O_NOFOLLOW", 0))
            raw = os.fdopen(descriptor, "rb")
        else:
            raw = source
        try:
            info = os.fstat(raw.fileno())
        except (AttributeError, OSError):
            # BytesIO is useful for tests and trusted, in-memory callers.
            current = raw.tell()
            raw.seek(0, 2)
            size = raw.tell()
            raw.seek(current)
        else:
            if not stat.S_ISREG(info.st_mode):
                raise ValidationError("Music analysis requires an ordinary media file.")
            size = info.st_size
        if not 0 < size <= MAX_BYTES:
            raise ValidationError("Music analysis requires a nonempty file of at most 8 GiB.")
        raw.seek(0)
        yield raw
    finally:
        if owned and raw is not None:
            raw.close()


class _EnergyFrames:
    def __init__(self, rate, start, end, deadline):
        import numpy as np
        self.rate = rate
        self.frame_samples = max(1, round(rate * FRAME_SECONDS))
        self.start = round(start * rate)
        self.end = round(end * rate) if end is not None else None
        self.deadline = deadline
        self.pending = np.empty(0, dtype=np.float32)
        self.frames = []
        self.cursor = 0
        self.selected = 0
        self.peak = 0.0
        self.clipped = 0

    def add(self, data):
        import numpy as np
        if time.monotonic() > self.deadline:
            raise ValidationError("Music analysis timed out; analyze a shorter recording.")
        if data.ndim != 2 or not data.shape[0] or data.shape[0] > 8:
            raise ValidationError("Music analysis supports one to eight audio channels.")
        count = data.shape[1]
        last = self.cursor + count
        if last > self.rate * MAX_SECONDS:
            raise ValidationError("Music analysis supports recordings up to six hours.")
        if not np.isfinite(data).all():
            raise ValidationError("Audio contains non-finite samples.")
        left = max(self.cursor, self.start)
        right = min(last, self.end if self.end is not None else last)
        if right > left:
            selected = data[:, left - self.cursor:right - self.cursor]
            magnitude = np.abs(selected)
            self.peak = max(self.peak, float(magnitude.max()))
            self.clipped += int(np.count_nonzero(magnitude >= 0.9999))
            # Channel powers preserve energy even for opposite-phase stereo.
            power = np.mean(np.square(selected, dtype=np.float64), axis=0)
            pending = np.concatenate((self.pending, power))
            size = (len(pending) // self.frame_samples) * self.frame_samples
            if size:
                self.frames.append(np.mean(pending[:size].reshape(-1, self.frame_samples), axis=1))
            self.pending = pending[size:]
            self.selected += right - left
        self.cursor = last

    def finish(self):
        import numpy as np
        if self.pending.size:
            self.frames.append(np.array([self.pending.mean()], dtype=np.float64))
        if not self.selected:
            raise ValidationError("The requested analysis range contains no audio.")
        duration = self.cursor / self.rate
        if self.end is not None and self.end > self.cursor:
            raise ValidationError("The requested analysis end exceeds the actual audio duration.")
        return np.sqrt(np.concatenate(self.frames)).astype(np.float64), duration


def _pcm(raw, start, end, deadline):
    """Stream ordinary PCM WAV without importing PyAV or loading full audio."""
    import numpy as np
    try:
        source = wave.open(raw, "rb")
    except (wave.Error, EOFError):
        return None
    with source:
        rate, channels, width = source.getframerate(), source.getnchannels(), source.getsampwidth()
        if not 1000 <= rate <= 192000 or not 1 <= channels <= 8 or width not in (1, 2, 3, 4):
            raise ValidationError("Unsupported WAV sample rate, channel count, or sample width.")
        if source.getnframes() / rate > MAX_SECONDS:
            raise ValidationError("Music analysis supports recordings up to six hours.")
        frames = _EnergyFrames(rate, start, end, deadline)
        total_bytes = 0
        while chunk := source.readframes(rate):
            total_bytes += len(chunk)
            if len(chunk) % (width * channels):
                raise ValidationError("The WAV file contains an incomplete audio frame.")
            if width == 1:
                samples = (np.frombuffer(chunk, dtype=np.uint8).astype(np.float32) - 128) / 128
            elif width == 3:
                values = np.frombuffer(chunk, dtype=np.uint8).reshape(-1, 3).astype(np.int32)
                values = values[:, 0] | values[:, 1] << 8 | values[:, 2] << 16
                samples = ((values ^ 0x800000) - 0x800000).astype(np.float32) / 8388608
            else:
                samples = np.frombuffer(chunk, dtype=f"<i{width}").astype(np.float32) / (2 ** (width * 8 - 1))
            frames.add(samples.reshape(-1, channels).T)
        if total_bytes != source.getnframes() * width * channels:
            raise ValidationError("The WAV file is truncated.")
        rms, duration = frames.finish()
        return rms, duration, frames, rate, channels


def _decode(source, start, end):
    deadline = time.monotonic() + PROCESSING_TIMEOUT
    with _source(source) as raw:
        result = _pcm(raw, start, end, deadline)
        if result is not None:
            return result
        raw.seek(0)
        # Reuse the existing self-contained-media allowlist and secondary-I/O
        # denial. Passing a handle prevents filenames being treated as URLs.
        from .media import _open_audio_source
        try:
            import av
        except ImportError:
            raise ValidationError("Compressed music analysis requires PyAV in the ComfyUI runtime; PCM WAV works without it.") from None
        try:
            with _open_audio_source(raw) as media:
                if not media.streams.audio:
                    raise ValidationError("The file has no audio stream.")
                stream = media.streams.audio[0]
                rate = stream.codec_context.sample_rate
                channels = stream.codec_context.channels
                if not 1000 <= rate <= 192000 or not 1 <= channels <= 8:
                    raise ValidationError("Unsupported audio sample rate or channel count.")
                frames = _EnergyFrames(12000, start, end, deadline)
                resampler = av.AudioResampler(format="fltp", layout="stereo", rate=12000)
                for decoded in media.decode(audio=0):
                    for frame in resampler.resample(decoded):
                        frames.add(frame.to_ndarray())
                for frame in resampler.resample(None):
                    frames.add(frame.to_ndarray())
                rms, duration = frames.finish()
                return rms, duration, frames, rate, channels
        except ValidationError:
            raise
        except Exception:
            raise ValidationError("Could not decode this self-contained audio file for music analysis.") from None


def _onsets_and_beats(rms, dt, start):
    import numpy as np
    novelty = np.maximum(0, np.diff(rms, prepend=0))
    positive = novelty[novelty > 1e-6]
    empty = ({"bpm": None, "confidence": 0.0, "method": "onset_periodicity"}, [], [], 0)
    if len(positive) < 2 or float(rms.max()) < 1e-5:
        return empty
    threshold = max(1e-5, float(novelty.max()) * 0.12, float(np.percentile(positive, 50)) * 0.5)
    peaks = np.flatnonzero((novelty > threshold) & (novelty >= np.roll(novelty, 1)) & (novelty >= np.roll(novelty, -1)))
    selected = []
    minimum_gap = max(1, round(0.09 / dt))
    for index in peaks:
        if selected and index - selected[-1] < minimum_gap:
            if novelty[index] > novelty[selected[-1]]:
                selected[-1] = int(index)
        else:
            selected.append(int(index))
    peaks = np.array(selected, dtype=np.int64)
    strengths = novelty[peaks] / max(float(novelty.max()), 1e-12)
    top = np.argsort(strengths)[-MAX_ONSETS:]
    onsets = [{"timeSeconds": round(start + float(peaks[i]) * dt, 6), "strength": round(float(strengths[i]), 4)}
              for i in sorted(top, key=lambda i: peaks[i])]
    if len(peaks) < 6:
        return empty[0], [], onsets, len(peaks)
    # At most five one-minute excerpts keep tempo work bounded for long files.
    window = min(len(novelty), max(1, round(60 / dt)))
    offsets = np.unique(np.linspace(0, len(novelty) - window, min(5, math.ceil(len(novelty) / window)), dtype=int))
    samples = [novelty[offset:offset + window] for offset in offsets]
    denominator = sum(float(np.dot(part, part)) for part in samples)
    lags = range(max(1, round(60 / 200 / dt)), max(2, round(60 / 55 / dt)) + 1)
    scores = [(sum(float(np.dot(part[:-lag], part[lag:])) for part in samples if len(part) > lag) /
               max(denominator, 1e-12), lag) for lag in lags]
    correlation, lag = max(scores, key=lambda pair: (pair[0], -pair[1]))
    if correlation < 0.18:
        return empty[0], [], onsets, len(peaks)
    period = lag * dt
    gaps = np.diff(peaks) * dt
    # Quantized envelopes can correlate more strongly after two beats. Prefer
    # the faster pulse when most observed attacks actually occur halfway there.
    half = period / 2
    if half >= 60 / 200 and np.mean((gaps > half * 0.8) & (gaps < half * 1.2)) >= 0.6:
        period = half
    matching = gaps[(gaps > period * 0.8) & (gaps < period * 1.2)]
    if len(matching) >= 4:
        period = float(matching.mean())
    relative_times = peaks * dt
    phases = np.mod(relative_times, period)
    bins = 48
    histogram, edges = np.histogram(phases, bins=bins, range=(0, period), weights=strengths)
    phase = float(edges[int(np.argmax(histogram))] + period / bins / 2)
    distance = np.abs((phases - phase + period / 2) % period - period / 2)
    beat_indices = peaks[distance <= max(dt * 1.5, period * 0.15)]
    confidence = min(1.0, correlation) * min(1.0, len(beat_indices) / 12)
    if len(beat_indices) < 4:
        return empty[0], [], onsets, len(peaks)
    beats = [round(start + float(index) * dt, 6) for index in beat_indices]
    return {"bpm": round(60 / period, 2), "confidence": round(confidence, 3), "method": "onset_periodicity"}, beats, onsets, len(peaks)


def _sections(relative, rms, dt, start, end):
    import numpy as np
    step = max(1, round(1 / dt))
    means = np.array([float(relative[i:i + step].mean()) for i in range(0, len(relative), step)])
    absolute = np.array([float(rms[i:i + step].mean()) for i in range(0, len(rms), step)])
    levels = np.where(absolute < 1e-5, 0, np.where(means < 0.33, 1, np.where(means < 0.67, 2, 3)))
    changes = []
    for i in range(2, len(means) - 1):
        before, after = means[max(0, i - 2):i].mean(), means[i:min(len(means), i + 2)].mean()
        if levels[i] != levels[i - 1] and abs(after - before) >= 0.1:
            changes.append((float(abs(after - before)), i))
    boundaries = [0]
    for _, index in sorted(changes, reverse=True):
        if all(abs(index - existing) >= 2 for existing in boundaries):
            boundaries.append(index)
            if len(boundaries) >= MAX_SECTIONS:
                break
    boundaries = sorted(boundaries) + [len(means)]
    result = []
    for left, right in zip(boundaries, boundaries[1:]):
        values = means[left:right]
        average = float(values.mean())
        delta = float(values[-1] - values[0])
        silent = bool(np.max(absolute[left:right]) < 1e-5)
        result.append({"startSeconds": round(start + left * step * dt, 6),
                       "endSeconds": round(min(end, start + right * step * dt), 6),
                       "energyLevel": "silent" if silent else "low" if average < 0.33 else "medium" if average < 0.67 else "high",
                       "meanEnergy": round(average, 4),
                       "trend": "rising" if delta > 0.12 else "falling" if delta < -0.12 else "steady",
                       "confidence": 0.5, "method": "energy_change"})
    return result


def _candidates(relative, dt, start, end, length, beats, sections):
    import numpy as np
    if length > end - start + 1e-7:
        return []
    last = end - length
    # Preserve exact beat/section starts while bounding evaluation cost.
    positions = np.unique(np.concatenate((np.linspace(start, last, min(4096, max(1, math.ceil(last - start) + 1))),
                                          np.array(beats[:MAX_BEATS], dtype=float),
                                          np.array([part["startSeconds"] for part in sections], dtype=float))))
    positions = positions[(positions >= start) & (positions <= last + 1e-8)]
    prefix = np.concatenate(([0.0], np.cumsum(relative)))
    n = len(relative)
    left = np.clip(np.floor((positions - start) / dt).astype(int), 0, n - 1)
    right = np.clip(np.ceil((positions - start + length) / dt).astype(int), left + 1, n)
    mean = (prefix[right] - prefix[left]) / (right - left)
    quarter = np.maximum(1, (right - left) // 4)
    change = (prefix[right] - prefix[right - quarter] - prefix[left + quarter] + prefix[left]) / quarter
    beat_array = np.array(beats, dtype=float)
    result = []
    for profile, scores in (("high_energy", mean), ("low_energy", 1 - mean), ("build", np.clip(change, 0, 1))):
        chosen = []
        for index in np.argsort(-scores, kind="stable"):
            position = float(positions[index])
            if any(abs(position - existing) < max(0.1, length * 0.25) for existing in chosen):
                continue
            chosen.append(position)
            result.append({"startSeconds": round(position, 6), "endSeconds": round(position + length, 6),
                           "profile": profile, "score": round(float(scores[index]), 4),
                           "meanEnergy": round(float(mean[index]), 4), "energyChange": round(float(change[index]), 4),
                           "beatAligned": bool(beat_array.size and np.min(np.abs(beat_array - position)) <= dt * 1.5)})
            if len(chosen) == 3:
                break
    return result


def analyze_music(source, *, start_seconds=0.0, end_seconds=None, target_duration_seconds=None):
    """Return bounded, JSON-safe source timestamps and placement measurements.

    Time values are absolute seconds in the source recording. Confidence values
    are heuristic strengths, not calibrated probabilities. Full source duration
    is measured; an analysis range never pads missing source audio with silence.
    """
    start = _number(start_seconds, "Analysis start")
    end = None if end_seconds is None else _number(end_seconds, "Analysis end")
    if end is not None and end <= start:
        raise ValidationError("Analysis end must be after its start.")
    target = None if target_duration_seconds is None else _number(target_duration_seconds, "Target duration", minimum=0.1)
    try:
        import numpy as np
    except ImportError:
        raise ValidationError("Music analysis requires NumPy in the ComfyUI Python environment.") from None
    rms, duration, frames, source_rate, channels = _decode(source, start, end)
    start = frames.start / frames.rate
    end = min(duration, frames.end / frames.rate if frames.end is not None else duration)
    dt = frames.frame_samples / frames.rate
    silent = bool(float(rms.max()) < 1e-5)
    scale = max(float(np.percentile(rms, 95)), float(rms.max()) * 0.1, 1e-5)
    relative = np.zeros_like(rms) if silent else np.clip(rms / scale, 0, 1)
    tempo, all_beats, onsets, onset_count = _onsets_and_beats(rms, dt, start)
    sections = _sections(relative, rms, dt, start, end)
    points = []
    for indexes in np.array_split(np.arange(len(rms)), min(MAX_ENERGY_POINTS, len(rms))):
        value = float(np.sqrt(np.mean(np.square(rms[indexes]))))
        points.append({"timeSeconds": round(min(end, start + (float(indexes[0]) + float(indexes[-1]) + 1) * dt / 2), 6),
                       "rms": round(value, 8), "db": round(20 * math.log10(max(value, 1e-6)), 2),
                       "relative": round(float(relative[indexes].mean()), 4)})
    beat_count = len(all_beats)
    beats = all_beats if beat_count <= MAX_BEATS else [all_beats[i] for i in np.linspace(0, beat_count - 1, MAX_BEATS, dtype=int)]
    candidates = [] if silent else _candidates(relative, dt, start, end, target or min(15.0, end - start), all_beats, sections)
    limitations = ["Signal-derived energy sections are not verse, chorus, drop, mood, instrument, or vocal labels.",
                   "Beat/tempo estimates assume a broadly steady pulse and can be half/double-time or miss weak beats; preview important edit points.",
                   "Confidence and window scores are heuristics, not calibrated probabilities; relative energy is normalized within this analysis range."]
    if target is not None and target > end - start + 1e-7:
        limitations.append("The requested placement duration exceeds the analyzed audio; no full-length candidate window is available.")
    return {"version": VERSION, "method": "pcm_energy_onset_v1", "durationSeconds": round(duration, 6),
            "sourceSampleRate": source_rate, "channels": channels,
            "analyzedRange": {"startSeconds": round(start, 6), "endSeconds": round(end, 6)},
            "silent": silent, "peakAmplitude": round(frames.peak, 6), "tempo": tempo,
            "beatsSeconds": beats, "onsets": onsets, "energy": points, "sections": sections,
            "candidateWindows": candidates, "limits": {"beatCount": beat_count, "beatsTruncated": beat_count > MAX_BEATS,
                "onsetCount": onset_count, "onsetsTruncated": onset_count > MAX_ONSETS,
                "energyPointCount": len(points), "energyFrameSeconds": round(dt, 8),
                "energyAggregated": len(rms) > MAX_ENERGY_POINTS, "maxSourceSeconds": MAX_SECONDS},
            "limitations": limitations}
