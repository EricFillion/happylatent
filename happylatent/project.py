"""Versioned project contract. This module has no runtime dependencies."""
from __future__ import annotations

import math
from pathlib import PurePosixPath

from .audio_plan import SAMPLE_RATE, frame_sample

MAX_SCENES = 100
MAX_SCENE_SECONDS = 20
MAX_SCENE_PROMPT_LENGTH = 48000
# Retain the established editing/audio coordinate range independently of the
# generation limit so changing scene limits never truncates authored audio.
MAX_TIMELINE_SECONDS = 6000

DEFAULT_SAMPLING = {
    "steps": 8, "cfg": 1, "sampler": "euler_ancestral", "scheduler": "distilled", "imageStrength": 1,
}
SAMPLING_PRESETS = {
    "distilled": {"steps": 8, "cfg": 1, "sampler": "euler_ancestral", "scheduler": "distilled"},
    "full": {"steps": 50, "cfg": 3, "sampler": "euler_ancestral", "scheduler": "custom"},
}
# Match ECMAScript String.trim(), used by the editor for names and required IDs.
# Python's default strip() differs for BOM, NEL, and some control characters.
_TEXT_WHITESPACE = "\t\n\v\f\r \u00a0\u1680\u2000\u2001\u2002\u2003\u2004\u2005\u2006\u2007\u2008\u2009\u200a\u2028\u2029\u202f\u205f\u3000\ufeff"


class ValidationError(ValueError):
    pass


def _integer(value, name, minimum, maximum):
    # JSON has one number type in JavaScript: 24, 24.0 and 2.4e1 are equivalent.
    if (isinstance(value, bool) or not isinstance(value, (int, float))
            or not minimum <= value <= maximum or value != int(value)):
        raise ValidationError(f"{name} must be an integer between {minimum} and {maximum}.")
    return int(value)


def _timeline_frame(value, name, fps, minimum=0):
    if isinstance(value, (int, float)) and not isinstance(value, bool) and value > fps * MAX_TIMELINE_SECONDS:
        raise ValidationError(f"{name} exceeds the supported timeline range.")
    return _integer(value, name, minimum, fps * MAX_TIMELINE_SECONDS)


def _scene_duration(value, fps):
    if isinstance(value, (int, float)) and not isinstance(value, bool) and value > fps * MAX_SCENE_SECONDS:
        raise ValidationError("Clip duration cannot exceed 20 seconds. Split longer videos into multiple clips.")
    return _integer(value, "Clip duration", 1, fps * MAX_SCENE_SECONDS)


def _number(value, name, minimum, maximum):
    if (isinstance(value, bool) or not isinstance(value, (int, float))
            or not minimum <= value <= maximum or not math.isfinite(value)):
        raise ValidationError(f"{name} must be a number between {minimum} and {maximum}.")
    # JSON.stringify turns -0 into 0; keep validation/serialization idempotent.
    return 0 if value == 0 else value


def validate_sampling(raw):
    if not isinstance(raw, dict):
        raise ValidationError("Sampling settings must be an object.")
    result = DEFAULT_SAMPLING | raw
    result["steps"] = _integer(result["steps"], "Steps", 2, 100)
    result["cfg"] = _number(result["cfg"], "CFG", 0, 30)
    result["imageStrength"] = _number(result["imageStrength"], "Image strength", 0, 1)
    if result["sampler"] not in ("euler_ancestral", "euler", "dpmpp_2m"):
        raise ValidationError("Unsupported sampler.")
    if result["scheduler"] not in ("distilled", "custom"):
        raise ValidationError("Unsupported scheduler.")
    if result["scheduler"] == "distilled" and result["steps"] != 8:
        raise ValidationError("The distilled schedule requires 8 steps.")
    return {key: result[key] for key in DEFAULT_SAMPLING}


def get_sampling(project, scene=None, *, resolved_preset=None):
    """Return independent scene settings, falling back for saved older projects."""
    global_settings = DEFAULT_SAMPLING | project.get("sampling", {})
    local = scene.get("sampling", {}) if scene is not None else {}
    result = global_settings | local | {"steps": global_settings["steps"]}
    preset = resolved_preset or project.get("samplingPreset")
    if preset in SAMPLING_PRESETS:
        result.update(SAMPLING_PRESETS[preset])
    return result


def get_image_strength(project, scene, target):
    override = scene.get({"first": "imageStrength", "last": "endImageStrength"}[target])
    return get_sampling(project, scene)["imageStrength"] if override is None else override


def min_scene_frames(scene):
    return 2 if scene.get("image") and scene.get("endImage") else 1


def assemble_scene_prompt(project, scene):
    """Pass authored text through unchanged, separated only by a blank line."""
    return "\n\n".join(part for part in (project["globalPrompt"], scene["prompt"]) if part != "")


def validate_scene_sampling(raw, global_settings):
    if not isinstance(raw, dict):
        raise ValidationError("Clip sampling settings must be an object.")
    if "steps" in raw:
        raise ValidationError("Steps are global and cannot be set per clip.")
    result = validate_sampling(global_settings | raw)
    return {key: value for key, value in result.items() if key != "steps"}


def validate_crop(raw):
    if not isinstance(raw, dict):
        raise ValidationError("Clip crop must be an object.")
    result = {axis: _number(raw.get(axis), f"Crop {axis}", 0, 1) for axis in ("x", "y")}
    if "scale" in raw:
        result["scale"] = _number(raw["scale"], "Crop scale", 0.1, 1)
    return result


def _text(value, name, limit, *, required=False):
    # Browser input limits and String.length count UTF-16 units, not code points.
    if (not isinstance(value, str)
            or len(value.encode("utf-16-le", errors="surrogatepass")) // 2 > limit
            or (required and not value.strip(_TEXT_WHITESPACE))):
        raise ValidationError(f"{name} must be {'nonempty ' if required else ''}text up to {limit} characters.")
    return value


def validate_asset(raw, *, allow_output=False):
    if not isinstance(raw, dict):
        raise ValidationError("Asset must be an object.")
    filename = _text(raw.get("filename"), "Asset filename", 255, required=True)
    subfolder = _text(raw.get("subfolder", "happylatent"), "Asset subfolder", 255)
    kind = raw.get("type", "input")
    if kind not in (("input", "output") if allow_output else ("input",)):
        raise ValidationError("Unsupported asset location.")
    if filename in (".", "..") or any(c in filename for c in ("/", "\\", "\0", "[", "]")):
        raise ValidationError("Invalid asset filename.")
    folder = PurePosixPath(subfolder)
    if "\\" in subfolder or "\0" in subfolder or folder.is_absolute() or ".." in folder.parts:
        raise ValidationError("Invalid asset subfolder.")
    if not folder.parts or folder.parts[0] != "happylatent":
        raise ValidationError("Assets must belong to the happylatent folder.")
    return {"filename": filename, "subfolder": str(folder), "type": kind}


def _scene_prompt(scene):
    parts = [_text(scene.get("prompt", ""), "Clip prompt", MAX_SCENE_PROMPT_LENGTH)]
    # Older v3 projects stored shot cards; retain their authored text on import.
    if "shots" in scene:
        if not isinstance(scene["shots"], list):
            raise ValidationError("Legacy shots must be an array.")
        for shot in scene["shots"]:
            if not isinstance(shot, dict):
                raise ValidationError("Legacy shot must be an object.")
            parts.append(_text(shot.get("prompt", ""), "Legacy shot prompt", 16000))
            if "audio" in shot:
                parts.append(_text(shot["audio"], "Legacy shot audio", 16000))
    return _text("\n\n".join(part for part in parts if part != ""), "Clip prompt", MAX_SCENE_PROMPT_LENGTH)


def validate_project(raw):
    if not isinstance(raw, dict):
        raise ValidationError("Project must be an object.")
    if raw.get("version") not in (1, 2, 3) or isinstance(raw.get("version"), bool):
        raise ValidationError("Unsupported project version. Expected version 1, 2 or 3.")
    if raw["version"] != 1 and "audio" in raw:
        raise ValidationError("Projects version 2 and later use audioSegments instead of audio.")
    if raw["version"] == 1 and "audioSegments" in raw:
        raise ValidationError("Audio segments require project version 2.")
    result = {"version": 3}
    result["id"] = _text(raw.get("id"), "Project id", 128, required=True)
    result["title"] = _text(raw.get("title", "Untitled project"), "Title", 200)
    result["fps"] = _integer(raw.get("fps"), "FPS", 1, 60)
    for key in ("width", "height"):
        value = _integer(raw.get(key), key, 64, 4096)
        if value % 32:
            raise ValidationError(f"{key} must be divisible by 32.")
        result[key] = value
    result["globalPrompt"] = _text(raw.get("globalPrompt", ""), "Global prompt", 16000)
    result["seed"] = _integer(raw.get("seed", 0), "Seed", 0, 2**53 - 1)
    if "samplingPreset" in raw:
        if raw["samplingPreset"] not in ("auto", "distilled", "full"):
            raise ValidationError("Sampling preset must be Auto, Distilled or Full.")
        result["samplingPreset"] = raw["samplingPreset"]
    if "sampling" in raw:
        result["sampling"] = validate_sampling(raw["sampling"])
    scenes = raw.get("scenes")
    if not isinstance(scenes, list) or not 1 <= len(scenes) <= MAX_SCENES:
        raise ValidationError("A project needs between 1 and 100 clips.")
    result["scenes"] = []
    ids = set()
    for index, scene in enumerate(scenes):
        if not isinstance(scene, dict):
            raise ValidationError(f"Clip {index + 1} must be an object.")
        item = {
            "id": _text(scene.get("id"), "Clip id", 128, required=True),
            "prompt": _scene_prompt(scene),
            "durationFrames": _scene_duration(scene.get("durationFrames"), result["fps"]),
        }
        if item["id"] in ids:
            raise ValidationError("Clip ids must be unique.")
        ids.add(item["id"])
        if "name" in scene:
            name = _text(scene["name"], "Clip name", 120)
            if name.strip(_TEXT_WHITESPACE):
                item["name"] = name.strip(_TEXT_WHITESPACE)
        if "audioMode" in scene:
            if scene["audioMode"] not in ("silent", "supplied", "generated"):
                raise ValidationError("Clip audio mode must be Silent, Provided audio, or Generated audio.")
            item["audioMode"] = scene["audioMode"]
        if "audioFallbackMode" in scene:
            if scene["audioFallbackMode"] not in ("silent", "generated"):
                raise ValidationError("Clip audio fallback must be generated or silent.")
            item["audioFallbackMode"] = scene["audioFallbackMode"]
        if "audioGuidance" in scene:
            if not isinstance(scene["audioGuidance"], bool):
                raise ValidationError("Use audio to guide video must be a boolean.")
            item["audioGuidance"] = scene["audioGuidance"]
        if scene.get("image") is not None:
            item["image"] = validate_asset(scene["image"])
        if "crop" in scene:
            item["crop"] = validate_crop(scene["crop"])
        if scene.get("endImage") is not None:
            item["endImage"] = validate_asset(scene["endImage"])
        if "endCrop" in scene:
            item["endCrop"] = validate_crop(scene["endCrop"])
        for key in ("imageStrength", "endImageStrength"):
            if key in scene:
                item[key] = _number(scene[key], "Image strength", 0, 1)
        if "keyframes" in scene and scene["keyframes"] != []:
            raise ValidationError("Intermediate image keyframes are no longer supported. Remove them from this project or use the archived version.")
        if item["durationFrames"] == 1 and "image" in item and "endImage" in item:
            raise ValidationError("First and last frame images require a clip of at least 2 frames.")
        if "sampling" in scene:
            # Stored legacy controls remain valid independently of the chosen
            # preset; presets replace their effective values at generation.
            item["sampling"] = validate_scene_sampling(scene["sampling"], DEFAULT_SAMPLING | result.get("sampling", {}))
        result["scenes"].append(item)
    for scene in result["scenes"]:
        _text(assemble_scene_prompt(result, scene), "Combined clip prompt", MAX_SCENE_PROMPT_LENGTH)
    segments = raw.get("audioSegments")
    if raw["version"] == 1:
        segments = []
    if raw["version"] == 1 and raw.get("audio") is not None:
        audio = raw["audio"]
        if not isinstance(audio, dict):
            raise ValidationError("Audio must be an object.")
        legacy = {
            "asset": validate_asset(audio.get("asset")),
            "offsetFrames": _timeline_frame(audio.get("offsetFrames", 0), "Audio offset", result["fps"]),
            "trimStartFrames": _integer(audio.get("trimStartFrames", 0), "Audio trim", 0, result["fps"] * 600),
        }
        segments = [{"id": "legacy-audio", "kind": "file", "startFrame": legacy["offsetFrames"],
                     "endFrame": None, "asset": legacy["asset"],
                     "sourceOffsetSamples": frame_sample(legacy["trimStartFrames"], result["fps"])}]
    if not isinstance(segments, list) or len(segments) > 100:
        raise ValidationError("Audio segments must be an array with at most 100 segments.")
    result["audioSegments"] = []
    ids = set()
    for index, segment in enumerate(segments):
        if not isinstance(segment, dict):
            raise ValidationError("Audio segment must be an object.")
        identifier = _text(segment.get("id"), "Audio segment id", 128, required=True)
        if identifier in ids:
            raise ValidationError("Audio segment ids must be unique.")
        ids.add(identifier)
        kind = segment.get("kind")
        if kind not in ("generate", "file"):
            raise ValidationError("Unsupported audio segment kind.")
        start = _timeline_frame(segment.get("startFrame"), "Audio start", result["fps"])
        if "endFrame" not in segment:
            raise ValidationError("Audio segment end is required.")
        end = segment["endFrame"]
        if end is not None:
            end = _timeline_frame(end, "Audio end", result["fps"], 1)
            if end <= start:
                raise ValidationError("Audio end must be after its start.")
        item = {"id": identifier, "kind": kind, "startFrame": start, "endFrame": end}
        if kind == "file":
            if "name" in segment:
                name = _text(segment["name"], "Audio name", 255).strip(_TEXT_WHITESPACE)
                if name:
                    item["name"] = name
            item["asset"] = validate_asset(segment.get("asset"))
            item["sourceOffsetSamples"] = _integer(segment.get("sourceOffsetSamples"), "Audio source offset", 0, SAMPLE_RATE * 600)
        elif "asset" in segment or "sourceOffsetSamples" in segment:
            raise ValidationError("Generated audio cannot contain a source file or source offset.")
        result["audioSegments"].append(item)
    result["audioSegments"].sort(key=lambda item: item["startFrame"])
    for previous, current in zip(result["audioSegments"], result["audioSegments"][1:]):
        if previous["endFrame"] is None or current["startFrame"] < previous["endFrame"]:
            raise ValidationError("Audio segments cannot overlap; only the last block can follow video end.")
    return result


def model_length(duration_frames):
    """Round up, never down, to the model's 8n+1 temporal grid."""
    return max(9, ((duration_frames - 1 + 7) // 8) * 8 + 1)


def scene_ranges(project):
    result, cursor = [], 0
    for scene in project["scenes"]:
        end = cursor + scene["durationFrames"]
        result.append({"scene": scene, "startFrame": cursor, "endFrame": end})
        cursor = end
    return result


def validate_generation_audio(project):
    """Keep legacy projects editable, but sample only one audio mode per clip."""
    for index, item in enumerate(scene_ranges(project)):
        segments = [segment for segment in project["audioSegments"]
                    if segment["startFrame"] < item["endFrame"]
                    and (segment["endFrame"] is None or segment["endFrame"] > item["startFrame"])]
        kinds = {segment["kind"] for segment in segments}
        mode = item["scene"].get("audioMode")
        reason = None
        if len(kinds) > 1:
            reason = "contains uploaded and generated audio"
        elif "generate" in kinds:
            coverage = sum(min(item["endFrame"], segment["endFrame"] if segment["endFrame"] is not None else item["endFrame"])
                           - max(item["startFrame"], segment["startFrame"]) for segment in segments)
            if coverage != item["scene"]["durationFrames"]:
                reason = "contains generated audio and silence"
        if reason is None:
            if mode == "silent" and kinds:
                reason = "is set to Silent but contains audio"
            elif mode == "generated" and kinds != {"generate"}:
                reason = "is set to Generated audio but lacks generated audio for the whole clip"
            elif mode == "supplied" and kinds != {"file"}:
                reason = "is set to Provided audio but lacks provided audio"
        if reason:
            raise ValidationError(f"Clip {index + 1} {reason}. Use one audio type per clip. "
                                  "Select Silent, Provided audio, or Generated audio for the whole clip.")
