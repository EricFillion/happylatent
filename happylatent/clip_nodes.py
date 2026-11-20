"""Execution helpers: immutable takes and media-only reuse, no model imports."""
from datetime import datetime, timezone
from fractions import Fraction
from io import BytesIO
import json

from .assets import open_asset
from .audio_plan import SAMPLE_RATE
from .clips import CLIP_FOLDER, RUN_FOLDER, _identifier, _run_name, output_root, read_clip, write_record
from .project import ValidationError, _integer, validate_video_take
from .safe_files import open_directory


class HappyLatentSaveTake:
    @classmethod
    def INPUT_TYPES(cls):
        return {"required": {"images": ("IMAGE",), "audio": ("AUDIO",), "fps": ("INT",), "record": ("STRING",)}}
    RETURN_TYPES = ("VIDEO", "AUDIO")
    FUNCTION = "save"
    CATEGORY = "Happy Latent/internal"
    DEPRECATED = True

    def save(self, images, audio, fps, record):
        from comfy_api.latest import InputImpl, Types
        record = json.loads(record)
        clip = validate_video_take(record["clip"])
        identifier = _identifier(clip["id"])
        if clip["asset"] != {"filename": identifier + ".mp4", "subfolder": CLIP_FOLDER, "type": "output"}:
            raise ValidationError("Generated takes must use their immutable output clip asset.")
        fps = _integer(fps, "Take FPS", 1, 120)
        if fps != clip["fps"] or clip["frameCount"] > fps * 20:
            raise ValidationError("Generated take timing is invalid.")
        if (images.shape[0], images.shape[2], images.shape[1]) != (clip["frameCount"], clip["width"], clip["height"]):
            raise ValidationError("Generated frames do not match the take metadata.")
        clip["createdAt"] = datetime.now(timezone.utc).isoformat()
        record["clip"] = clip
        video = InputImpl.VideoFromComponents(Types.VideoComponents(images=images, frame_rate=Fraction(fps),
            audio=audio if clip["hasAudio"] else None))
        buffer = BytesIO()
        video.save_to(buffer, format=Types.VideoContainer.MP4, codec=Types.VideoCodec.H264, preset="ultrafast")
        # Publish metadata only after the immutable file is completely written.
        with open_directory(output_root(), CLIP_FOLDER, create=True) as directory:
            try:
                with directory.open_file(clip["asset"]["filename"], "xb") as handle:
                    handle.write(buffer.getbuffer())
                write_record(CLIP_FOLDER, clip["id"] + ".json", record)
            except FileExistsError:
                existing = read_clip(clip["id"])
                old_clip = {key: value for key, value in existing["clip"].items() if key != "createdAt"}
                new_clip = {key: value for key, value in clip.items() if key != "createdAt"}
                if (existing["recipe"] != record["recipe"] or existing.get("runId") != record.get("runId")
                        or old_clip != new_clip or existing.get("scope") != record.get("scope")):
                    raise ValidationError("This take already exists. Use a new run ID.") from None
                clip = existing["clip"]
                with directory.open_file(clip["asset"]["filename"]) as handle:
                    buffer = BytesIO(handle.read())
        buffer.seek(0)
        return {"result": (InputImpl.VideoFromFile(buffer), audio), "ui": {"happylatent_clips": [clip],
            "projectId": [clip["projectId"]], "runId": [record["runId"]], "scope": [record["scope"]]}}


class HappyLatentLoadTake:
    @classmethod
    def INPUT_TYPES(cls):
        return {"required": {"selection": ("STRING",), "fps": ("INT",), "width": ("INT",),
                             "height": ("INT",), "frames": ("INT",), "samples": ("INT",)}}
    RETURN_TYPES = ("VIDEO", "AUDIO")
    FUNCTION = "load"
    CATEGORY = "Happy Latent/internal"
    DEPRECATED = True

    @classmethod
    def IS_CHANGED(cls, selection, **kwargs):
        from .assets import asset_fingerprint
        return asset_fingerprint(validate_video_take(json.loads(selection))["asset"], allow_output=True)

    def load(self, selection, fps, width, height, frames, samples):
        import torch
        from comfy_api.latest import InputImpl
        from .video_media import inspect_video, transcode_video
        selection = validate_video_take(json.loads(selection), selection=True)
        fps = _integer(fps, "Output FPS", 1, 120)
        width = _integer(width, "Output width", 2, 8192)
        height = _integer(height, "Output height", 2, 8192)
        frames = _integer(frames, "Output frames", 1, fps * 600)
        samples = _integer(samples, "Output samples", 1, SAMPLE_RATE * 600 + 1)
        if width % 2 or height % 2 or abs(samples - frames * SAMPLE_RATE / fps) > 1:
            raise ValidationError("Output video and audio timing must match.")
        buffer = BytesIO()
        with open_asset(selection["asset"], allow_output=True) as source:
            actual = inspect_video(source)
            for key in ("frameCount", "fps", "width", "height", "hasAudio"):
                if abs(float(actual[key]) - float(selection[key])) > 1e-5:
                    raise ValidationError("Selected video metadata no longer matches its file. Import it again.")
            _, pcm = transcode_video(source, buffer, metadata=actual, start_frame=selection["sourceStartFrame"],
                                    frames=frames, fps=fps, width=width, height=height, samples=samples)
        buffer.seek(0)
        return InputImpl.VideoFromFile(buffer), {"waveform": torch.from_numpy(pcm).unsqueeze(0), "sample_rate": SAMPLE_RATE}


class HappyLatentJoinAudio:
    @classmethod
    def INPUT_TYPES(cls):
        return {"required": {"samples": ("STRING",)}, "optional": {f"audio{i}": ("AUDIO",) for i in range(100)}}
    RETURN_TYPES = ("AUDIO",)
    FUNCTION = "join"
    CATEGORY = "Happy Latent/internal"
    DEPRECATED = True

    def join(self, samples, **inputs):
        import torch
        counts = json.loads(samples)
        if not isinstance(counts, list) or not 1 <= len(counts) <= 100:
            raise ValidationError("A soundtrack requires between 1 and 100 clips.")
        counts = [_integer(count, "Clip samples", 1, SAMPLE_RATE * 600 + 1) for count in counts]
        if sum(counts) > SAMPLE_RATE * 6000:
            raise ValidationError("The assembled soundtrack cannot exceed 6000 seconds.")
        if set(inputs) != {f"audio{i}" for i in range(len(counts))}:
            raise ValidationError("Soundtrack inputs must match its clip plan.")
        pieces = []
        for i, count in enumerate(counts):
            audio = inputs[f"audio{i}"]
            data = audio["waveform"].to(device="cpu", dtype=torch.float32)
            if audio["sample_rate"] != SAMPLE_RATE or data.shape != (1, 2, count) or not torch.isfinite(data).all():
                raise ValidationError("Clip audio does not match its exact timeline sample interval.")
            pieces.append(data)
        return ({"waveform": torch.cat(pieces, dim=-1), "sample_rate": SAMPLE_RATE},)


class HappyLatentPublishRun:
    @classmethod
    def INPUT_TYPES(cls):
        return {"required": {"video": ("VIDEO",), "run": ("STRING",)}}
    RETURN_TYPES = ("VIDEO",)
    FUNCTION = "publish"
    CATEGORY = "Happy Latent/internal"
    DEPRECATED = True

    def publish(self, video, run):
        run = json.loads(run)
        for i, clip in enumerate(run["clips"]):
            try:
                stored = read_clip(clip["id"])["clip"]
                run["clips"][i] = dict(stored, sceneId=clip["sceneId"])
            except (FileNotFoundError, ValidationError):
                pass
        write_record(RUN_FOLDER, _run_name(run["runId"]), run)
        return {"result": (video,), "ui": {"happylatent_clips": run["clips"], "projectId": [run["projectId"]],
            "runId": [run["runId"]], "scope": [run["scope"]]}}


CLIP_NODE_CLASSES = (HappyLatentSaveTake, HappyLatentLoadTake, HappyLatentJoinAudio, HappyLatentPublishRun)
