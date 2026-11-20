"""Immutable scene takes and model-free timeline compilation."""
from __future__ import annotations

from datetime import datetime, timezone
import hashlib
import json
from pathlib import Path
import re
import uuid

from .audio_plan import frame_sample, scene_audio_plan
from .project import ValidationError, _text, scene_ranges, validate_generation_audio, validate_project, validate_video_take
from .safe_files import open_directory

CLIP_FOLDER = "happylatent/clips"
RUN_FOLDER = "happylatent/runs"


def render_plan(project, render_mode="generate", scene_ids="[]"):
    if render_mode not in ("generate", "selected", "export"):
        raise ValidationError("Render mode must be generate, selected or export.")
    try:
        ids = json.loads(scene_ids) if isinstance(scene_ids, str) else scene_ids
    except (ValueError, TypeError):
        raise ValidationError("Selected scene IDs must be a JSON array.") from None
    known = {scene["id"] for scene in project["scenes"]}
    if (not isinstance(ids, list) or any(not isinstance(i, str) for i in ids)
            or len(ids) != len(set(ids)) or not set(ids) <= known):
        raise ValidationError("Selected scene IDs must be unique IDs in this project.")
    if render_mode == "selected" and not ids:
        raise ValidationError("Select at least one scene to regenerate.")
    if render_mode == "export" and any(not s.get("video") for s in project["scenes"]):
        raise ValidationError("Select an existing video for every scene before exporting.")
    generate = set(ids) if render_mode == "selected" else {
        s["id"] for s in project["scenes"] if not s.get("video") and render_mode == "generate"}
    scope = "project" if all(s.get("video") or s["id"] in generate for s in project["scenes"]) else "selection"
    included = known if scope == "project" else generate
    for scene in project["scenes"]:
        if scene["id"] in generate:
            if scene["durationFrames"] > project["fps"] * 20:
                raise ValidationError("Generated clips cannot exceed 20 seconds. Split this clip before generating.")
            if scene["durationFrames"] == 1 and "image" in scene and "endImage" in scene:
                raise ValidationError("First and last frame images require at least two frames when generating.")
    validate_generation_audio(project, generate)
    return generate, included, scope


def output_root():
    import folder_paths
    return Path(folder_paths.get_output_directory())


def _identifier(value):
    if not isinstance(value, str) or not re.fullmatch(r"[a-f0-9]{32}", value):
        raise ValidationError("Invalid saved clip ID.")
    return value


def _run_name(run_id):
    return hashlib.sha256(_text(run_id, "Run ID", 128, required=True).encode()).hexdigest() + ".json"


def write_record(folder, name, record):
    data = json.dumps(record, ensure_ascii=False, allow_nan=False).encode()
    with open_directory(output_root(), folder, create=True) as directory:
        try:
            with directory.open_file(name, "xb") as handle:
                handle.write(data)
        except FileExistsError:
            # Same ComfyUI execution/cache may visit the publishing node twice.
            with directory.open_file(name) as handle:
                if json.load(handle) != record:
                    raise ValidationError("This run ID was already used. Start a new run.") from None


def read_clip(identifier):
    name = _identifier(identifier) + ".json"
    with open_directory(output_root(), CLIP_FOLDER) as directory, directory.open_file(name) as handle:
        record = json.loads(handle.read(8 * 1024 * 1024))
    record["clip"] = validate_video_take(record["clip"])
    return record


def list_clips(project_id=None, run_id=None):
    root = output_root() / CLIP_FOLDER
    records = []
    if not root.exists():
        return records
    # Names from this scan are untrusted; every actual read is anchored/no-follow.
    for path in root.glob("*.json"):
        try:
            record = read_clip(path.stem)
            clip = record["clip"]
            if project_id is not None and clip.get("projectId") != project_id:
                continue
            if run_id is not None and record.get("runId") != run_id:
                continue
            records.append(clip)
        except (OSError, ValueError, KeyError, TypeError):
            continue
    return sorted(records, key=lambda c: (c.get("createdAt", ""), c["id"]), reverse=True)


def read_run(run_id):
    try:
        with open_directory(output_root(), RUN_FOLDER) as directory, directory.open_file(_run_name(run_id)) as handle:
            return json.loads(handle.read(8 * 1024 * 1024))
    except FileNotFoundError:
        clips = list_clips(run_id=run_id)
        if not clips:
            raise
        first = read_clip(clips[0]["id"])
        return {"runId": run_id, "projectId": clips[0].get("projectId"), "scope": first.get("scope", "project"),
                "clips": clips, "complete": False}


def register_import(asset, metadata, name="Imported clip"):
    clip = validate_video_take(dict(metadata, id=uuid.uuid4().hex, asset=asset,
        name=name[:120], createdAt=datetime.now(timezone.utc).isoformat()))
    write_record(CLIP_FOLDER, clip["id"] + ".json", {"clip": clip, "recipe": None})
    return clip


def compile_clips(raw, **options):
    from .compiler import compile_project
    project = validate_project(raw)
    mode, scene_ids, run_id = (options.pop(k) for k in ("render_mode", "scene_ids", "run_id"))
    run_id = _text(run_id, "Run ID", 128) or uuid.uuid4().hex
    generation, included, scope = render_plan(project, mode, scene_ids)
    prefix = options.get("prefix", "")
    graph = {}
    if generation:
        graph, _ = compile_project(project, **options, _generation_ids=generation)
        graph.pop(prefix + "sequence", None)
        graph.pop(prefix + "soundtrack", None)
    temporal = options.get("upscale_enabled") and options.get("upscale_mode") in ("temporal", "spatial+temporal")
    spatial = options.get("upscale_enabled") and options.get("upscale_mode") in ("spatial", "spatial+temporal")
    fps = project["fps"] * (2 if temporal else 1)
    width, height = project["width"] * (2 if spatial else 1), project["height"] * (2 if spatial else 1)
    videos, audios, clips, durations = [], {}, [], []

    def node(key, kind, **inputs):
        graph[prefix + key] = {"class_type": kind, "inputs": inputs}
        return [prefix + key, 0]

    for index, item in enumerate(scene_ranges(project)):
        scene = item["scene"]
        if scene["id"] not in included:
            continue
        stem = f"scene_{index}_"
        samples = frame_sample(item["endFrame"], project["fps"]) - frame_sample(item["startFrame"], project["fps"])
        count = scene["durationFrames"] * (2 if temporal else 1)
        if scene["id"] in generation:
            identifier = uuid.uuid5(uuid.NAMESPACE_URL, run_id + "\0" + project["id"] + "\0" + scene["id"]).hex
            clip = {"id": identifier, "asset": {"filename": identifier + ".mp4", "subfolder": CLIP_FOLDER, "type": "output"},
                    "frameCount": count, "fps": fps, "width": width, "height": height,
                    "hasAudio": bool(scene_audio_plan(project, item["startFrame"], scene["durationFrames"])),
                    "name": scene.get("name", f"Clip {index + 1}"), "projectId": project["id"], "sceneId": scene["id"]}
            plan = scene_audio_plan(project, item["startFrame"], scene["durationFrames"])
            generated = [r for r in plan if r["kind"] == "generate"]
            audio_inputs = {"generated.audio0": [prefix + stem + "audio_decode", 0]} if generated else {}
            mix = {"samples": samples, "regions": plan, "generated": [{"key": "audio0", "origin": 0, "regions": generated}] if generated else []}
            sound = node(stem + "take_audio", "HappyLatentAudioMix", plan=json.dumps(mix, sort_keys=True), **audio_inputs)
            recipe = {"project": project, "sceneId": scene["id"], "effectiveSeed": (project["seed"] + index) % 2**53,
                      "renderOptions": {key: options.get(key) for key in (
                          "upscale_enabled", "upscale_mode", "spatial_upscale_model_name",
                          "temporal_upscale_model_name", "refine_enabled", "model", "clip", "video_vae", "audio_vae")}}
            record = {"clip": clip, "recipe": recipe, "runId": run_id, "scope": scope}
            video = node(stem + "take", "HappyLatentSaveTake", images=[prefix + stem + "trim", 0], audio=sound,
                         fps=fps, record=json.dumps(record, sort_keys=True))
        else:
            clip = validate_video_take(scene["video"])
            # A take can be selected into another scene/project. The selection's
            # attribution belongs to this run, not its immutable source record.
            clip = dict(clip, sceneId=scene["id"])
            video = node(stem + "take", "HappyLatentLoadTake", selection=json.dumps(scene["video"], sort_keys=True),
                         fps=fps, width=width, height=height, frames=count, samples=samples)
        videos.append(video)
        audios[f"audio{len(videos) - 1}"] = [video[0], 1]
        durations.append(samples)
        clips.append(clip)
    sound = node("take_soundtrack", "HappyLatentJoinAudio", samples=json.dumps(durations), **audios)
    if project.get("musicSegments"):
        from .music_nodes import music_mix_plan
        music = music_mix_plan(project, included)
        if music["regions"]:
            sound = node("music_soundtrack", "HappyLatentMusicMix",
                         plan=json.dumps(music, sort_keys=True), base_audio=sound)
    sequence = node("sequence", "ConcatenateVideo", codec="h264", complete_audio=sound,
                    **{f"videos.video{i}": value for i, value in enumerate(videos)})
    run = {"runId": run_id, "projectId": project["id"], "scope": scope, "clips": clips, "complete": True}
    output = node("publish_run", "HappyLatentPublishRun", video=sequence, run=json.dumps(run, sort_keys=True))
    # Remove old silent wrappers and any unused generated paths. Every retained
    # dependency is reachable from the movie; reused scenes contain no sampler.
    needed = set()
    def visit(identifier):
        if identifier in needed or identifier not in graph:
            return
        needed.add(identifier)
        for value in graph[identifier]["inputs"].values():
            if isinstance(value, list) and len(value) == 2 and isinstance(value[0], str):
                visit(value[0])
    visit(output[0])
    return {key: value for key, value in graph.items() if key in needed}, output
