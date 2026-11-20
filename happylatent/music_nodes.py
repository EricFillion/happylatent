"""Measured-source music overlays, separate from video audio conditioning.

The compiler maps authored frame intervals into a final preview's sample space.
This node runs only on the assembled soundtrack, never on immutable scene takes.
"""
from __future__ import annotations

import math

from .audio_plan import SAMPLE_RATE, frame_sample
from .project import MAX_TIMELINE_SECONDS, ValidationError, _integer, _number, scene_ranges, validate_asset

MAX_SAMPLES = SAMPLE_RATE * MAX_TIMELINE_SECONDS
MAX_SOURCE_SAMPLES = SAMPLE_RATE * 600
PEAK_CEILING = 0.999


def music_mix_plan(project, included=None):
    """Map music into the joined output, including discontinuous scene previews.

    Fade offsets stay relative to the original authored segment. Selecting a
    later scene consequently neither restarts a fade nor rewinds the song.
    """
    included = None if included is None else set(included)
    regions = []
    destination = 0
    fps = project["fps"]
    for item in scene_ranges(project):
        if included is not None and item["scene"]["id"] not in included:
            continue
        scene_start = frame_sample(item["startFrame"], fps)
        scene_end = frame_sample(item["endFrame"], fps)
        for segment in project.get("musicSegments", []):
            start = max(item["startFrame"], segment["startFrame"])
            end = min(item["endFrame"], segment["endFrame"])
            if end <= start:
                continue
            segment_start = frame_sample(segment["startFrame"], fps)
            left, right = frame_sample(start, fps), frame_sample(end, fps)
            offset = left - segment_start
            regions.append({
                "asset": segment["asset"],
                "start": destination + left - scene_start,
                "end": destination + right - scene_start,
                "source": round(segment["sourceStartSeconds"] * SAMPLE_RATE) + offset,
                "sourceSamples": round(segment["audioDurationSeconds"] * SAMPLE_RATE),
                "offset": offset,
                "segmentSamples": frame_sample(segment["endFrame"], fps) - segment_start,
                "gainDb": segment["gainDb"],
                "fadeIn": round(segment["fadeInSeconds"] * SAMPLE_RATE),
                "fadeOut": round(segment["fadeOutSeconds"] * SAMPLE_RATE),
            })
        destination += scene_end - scene_start
    return validate_music_mix_plan({"samples": destination, "regions": regions})


def validate_music_mix_plan(plan):
    if not isinstance(plan, dict) or set(plan) != {"samples", "regions"}:
        raise ValidationError("Music mix plan must contain samples and regions.")
    samples = _integer(plan["samples"], "Music mix samples", 1, MAX_SAMPLES)
    if not isinstance(plan["regions"], list) or len(plan["regions"]) > 10000:
        raise ValidationError("Music mix has too many regions.")
    regions = []
    fields = {"asset", "start", "end", "source", "sourceSamples", "offset",
              "segmentSamples", "gainDb", "fadeIn", "fadeOut"}
    for raw in plan["regions"]:
        if not isinstance(raw, dict) or set(raw) != fields:
            raise ValidationError("Music mix region has invalid fields.")
        start = _integer(raw["start"], "Music mix start", 0, samples)
        end = _integer(raw["end"], "Music mix end", start + 1, samples)
        source_samples = _integer(raw["sourceSamples"], "Music source samples", 1, MAX_SOURCE_SAMPLES)
        source = _integer(raw["source"], "Music source offset", 0, source_samples)
        segment_samples = _integer(raw["segmentSamples"], "Music segment samples", 1, MAX_SOURCE_SAMPLES)
        offset = _integer(raw["offset"], "Music fade offset", 0, segment_samples)
        if source + end - start > source_samples or offset + end - start > segment_samples:
            raise ValidationError("Music placement extends beyond its measured source or authored interval.")
        fade_in = _integer(raw["fadeIn"], "Music fade in", 0, SAMPLE_RATE * 30)
        fade_out = _integer(raw["fadeOut"], "Music fade out", 0, SAMPLE_RATE * 30)
        if fade_in + fade_out > segment_samples:
            raise ValidationError("Music fades cannot exceed the authored interval.")
        regions.append({
            "asset": validate_asset(raw["asset"]), "start": start, "end": end,
            "source": source, "sourceSamples": source_samples, "offset": offset,
            "segmentSamples": segment_samples,
            "gainDb": _number(raw["gainDb"], "Music gain", -60, 6),
            "fadeIn": fade_in, "fadeOut": fade_out,
        })
    return {"samples": samples, "regions": regions}


def read_music_window(asset, start, count, expected_samples):
    """Read exact source samples. Unlike conditioning, EOF never becomes silence."""
    import numpy as np
    import wave
    from .assets import open_asset
    from .media import decode_audio

    with open_asset(asset) as handle:
        try:
            header = handle.read(36)
            handle.seek(0)
            with wave.open(handle, "rb") as source:
                normalized = (header[:4] == b"RIFF" and header[8:20] == b"WAVEfmt \x10\x00\x00\x00"
                              and header[20:22] == b"\x01\x00"
                              and (source.getnchannels(), source.getframerate(), source.getsampwidth(),
                                   source.getcomptype()) == (2, SAMPLE_RATE, 2, "NONE"))
                if normalized:
                    actual_samples = source.getnframes()
                    if abs(actual_samples - expected_samples) > 1:
                        raise ValidationError("Music source duration changed. Analyze and place the current asset again.")
                    if start + count > actual_samples:
                        raise ValidationError("Music source ends before the requested placement; shorten the placement or choose another source.")
                    source.setpos(start)
                    raw = source.readframes(count)
                    if len(raw) != count * 4:
                        raise ValidationError("Music WAV is truncated; import a complete recording.")
                    return np.frombuffer(raw, dtype="<i2").reshape(-1, 2).T.astype(np.float32) / 32768
        except (wave.Error, EOFError):
            pass
        # Imported assets are normalized WAV, but previously saved input assets
        # may use another self-contained format. The existing decoder denies
        # external I/O and enforces its ten-minute source limit.
        handle.seek(0)
        data = decode_audio(handle)
        if abs(data.shape[1] - expected_samples) > 1:
            raise ValidationError("Music source duration changed. Analyze and place the current asset again.")
        if start + count > data.shape[1]:
            raise ValidationError("Music source ends before the requested placement; shorten the placement or choose another source.")
        return data[:, start:start + count].copy()


def mix_music_pcm(base, plan, *, reader=None):
    """Add music to stereo 48 kHz PCM and return (PCM, peak-protection report)."""
    import numpy as np

    plan = validate_music_mix_plan(plan)
    reader = reader or read_music_window
    if base is None:
        output = np.zeros((2, plan["samples"]), dtype=np.float32)
    else:
        data = np.asarray(base)
        if data.shape != (2, plan["samples"]) or not np.isfinite(data).all():
            raise ValidationError("Original soundtrack must match the exact stereo music mix interval and contain finite samples.")
        output = data.astype(np.float32, copy=True)
    for region in plan["regions"]:
        start, end = region["start"], region["end"]
        data = reader(region["asset"], region["source"], end - start, region["sourceSamples"])
        if data.shape != (2, end - start) or not np.isfinite(data).all():
            raise ValidationError("Music decoder must return the complete finite stereo source interval.")
        gain = 10 ** (region["gainDb"] / 20)
        # Bounded envelope arrays; avoid a second project-sized allocation.
        for left in range(0, end - start, SAMPLE_RATE):
            right = min(end - start, left + SAMPLE_RATE)
            position = np.arange(region["offset"] + left, region["offset"] + right, dtype=np.float64)
            envelope = np.full(right - left, gain, dtype=np.float64)
            if region["fadeIn"]:
                envelope *= np.minimum(1, position / region["fadeIn"])
            if region["fadeOut"]:
                remaining = region["segmentSamples"] - 1 - position
                envelope *= np.minimum(1, remaining / region["fadeOut"])
            output[:, start + left:start + right] += data[:, left:right] * envelope
    peak = 0.0
    for left in range(0, plan["samples"], SAMPLE_RATE):
        chunk = output[:, left:left + SAMPLE_RATE]
        if not np.isfinite(chunk).all():
            raise ValidationError("Music mixing produced non-finite samples.")
        peak = max(peak, float(np.max(np.abs(chunk))))
    scale = min(1.0, PEAK_CEILING / peak) if peak else 1.0
    if scale < 1:
        # One fixed attenuation preserves the balance and dynamics of speech
        # and music; never hard-clip the sum or use a pumping per-sample limiter.
        output *= scale
    return output, {"method": "additive_overlay", "peakBeforeProtection": peak,
                    "peakCeiling": PEAK_CEILING, "attenuationDb": 20 * math.log10(scale),
                    "note": "Original audio is retained. Fixed attenuation is applied to the complete mix only when its peak exceeds the ceiling."}


class HappyLatentMusicMix:
    @classmethod
    def INPUT_TYPES(cls):
        return {"required": {"plan": ("STRING",)}, "optional": {"base_audio": ("AUDIO",)}}

    RETURN_TYPES = ("AUDIO",)
    FUNCTION = "mix"
    CATEGORY = "Happy Latent/internal"
    DEPRECATED = True

    @classmethod
    def IS_CHANGED(cls, plan, **kwargs):
        from .assets import asset_fingerprint
        from .audio_nodes import parse_audio_json
        parsed = validate_music_mix_plan(parse_audio_json(plan))
        return tuple(asset_fingerprint(region["asset"]) for region in parsed["regions"])

    def mix(self, plan, base_audio=None):
        import torch
        from .audio_nodes import parse_audio_json
        base = None
        if base_audio is not None:
            data = base_audio["waveform"]
            if base_audio["sample_rate"] != SAMPLE_RATE or data.ndim != 3 or data.shape[0] != 1:
                raise ValidationError("Original soundtrack must be one stereo 48 kHz waveform.")
            base = data.detach().to(device="cpu", dtype=torch.float32).numpy()
            base = base[0]
        pcm, report = mix_music_pcm(base, parse_audio_json(plan))
        return ({"waveform": torch.from_numpy(pcm).unsqueeze(0), "sample_rate": SAMPLE_RATE,
                 "music_mix": report},)
