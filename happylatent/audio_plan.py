"""Frame/sample boundaries and scene-local audio plans; no runtime imports."""
from __future__ import annotations

SAMPLE_RATE = 48000


def frame_sample(frame, fps):
    """Round rational frame positions to the nearest sample, ties to even."""
    quotient, remainder = divmod(frame * SAMPLE_RATE, fps)
    return quotient + (remainder * 2 > fps or (remainder * 2 == fps and quotient % 2))


def audio_regions(project, start_frame=0, end_frame=None):
    """Resolve authored ownership into absolute half-open sample intervals."""
    total = sum(scene["durationFrames"] for scene in project["scenes"])
    end_frame = total if end_frame is None else min(end_frame, total)
    fps = project["fps"]
    result = []
    for segment in project["audioSegments"]:
        left = max(start_frame, segment["startFrame"])
        right = min(end_frame, total if segment["endFrame"] is None else segment["endFrame"])
        if right <= left:
            continue
        item = {"kind": segment["kind"], "start": frame_sample(left, fps), "end": frame_sample(right, fps)}
        if segment["kind"] == "file":
            item.update(asset=segment["asset"].copy(), source=segment["sourceOffsetSamples"]
                        + item["start"] - frame_sample(segment["startFrame"], fps))
        result.append(item)
    return result


def scene_audio_plan(project, start_frame, frames):
    origin = frame_sample(start_frame, project["fps"])
    return [item | {"start": item["start"] - origin, "end": item["end"] - origin}
            for item in audio_regions(project, start_frame, start_frame + frames)]


def conditioning_regions(plan, samples):
    """Sample non-file context within the authored clip when generating audio.

    The validated scene-local plan stays unchanged for final soundtrack mixing.
    Conditioning intervals do not extend into model padding.
    """
    if not any(region["kind"] == "generate" for region in plan):
        return []
    result, cursor = [], 0
    for region in plan:
        if region["kind"] != "file":
            continue
        if region["start"] > cursor:
            result.append({"kind": "generate", "start": cursor, "end": region["start"]})
        cursor = region["end"]
    if cursor < samples:
        result.append({"kind": "generate", "start": cursor, "end": samples})
    return result
