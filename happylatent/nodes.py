"""ComfyUI-native editor node and small media utilities used by its expansion."""
from __future__ import annotations

import json

from .compiler import compile_project
from .project import MAX_SCENE_SECONDS, MAX_TIMELINE_SECONDS, ValidationError, _integer, model_length, validate_generation_audio, validate_project

DEFAULT_PROJECT = json.dumps({
    "version": 3, "id": "happylatent-project", "title": "Garden morning",
    "fps": 24, "width": 1024, "height": 576, "seed": 42,
    "globalPrompt": "A peaceful morning in a sunlit garden. Natural colors, soft golden light, and realistic cinematic photography.",
    "samplingPreset": "auto",
    "scenes": [
        {"id": "scene-1", "name": "Garden path", "durationFrames": 120,
         "prompt": "A wide shot of a garden path surrounded by flowers. A gentle breeze moves the petals and leaves as the camera slowly glides forward. Birds chirp in the distance."},
        {"id": "scene-2", "name": "Butterfly", "durationFrames": 120,
         "prompt": "A close-up of a butterfly resting on a flower. It slowly opens and closes its wings while the flower sways gently. The camera stays steady, with soft birdsong in the background."},
    ],
    "audioSegments": [{"id": "audio-1", "kind": "generate", "startFrame": 0, "endFrame": None}],
})


def _reject_json_constant(value):
    # Match JSON.parse in the browser, including constants in ignored fields.
    raise ValidationError("HappyLatentVideo project must be valid JSON.")


def parse_project(project):
    try:
        return validate_project(json.loads(project, parse_constant=_reject_json_constant))
    except (json.JSONDecodeError, TypeError) as error:
        raise ValidationError("HappyLatentVideo project must be valid JSON.") from error


def project_assets(project):
    for scene in project["scenes"]:
        for key in ("image", "endImage"):
            if scene.get(key):
                yield scene[key]
    for segment in project["audioSegments"]:
        if segment["kind"] == "file":
            yield segment["asset"]


class HappyLatentVideo:
    @classmethod
    def INPUT_TYPES(cls):
        return {"required": {
            "model": ("MODEL", {"rawLink": True}),
            "clip": ("CLIP", {"rawLink": True}),
            "video_vae": ("VAE", {"rawLink": True}),
            "audio_vae": ("VAE", {"rawLink": True}),
            "project": ("STRING", {"default": DEFAULT_PROJECT, "multiline": True}),
        }, "hidden": {"prompt": "PROMPT"}}

    RETURN_TYPES = ("VIDEO",)
    RETURN_NAMES = ("video",)
    FUNCTION = "generate"
    CATEGORY = "HappyLatent"
    DESCRIPTION = "Arrange clips, prompts and images. Choose exactly one audio mode per clip: silent, provided audio or generated audio. Connect the model, text encoder, video VAE and audio VAE, then send VIDEO to Save Video."

    @classmethod
    def VALIDATE_INPUTS(cls, project):
        try:
            validate_generation_audio(parse_project(project))
        except ValidationError as error:
            return str(error)
        return True

    @classmethod
    def IS_CHANGED(cls, project, **kwargs):
        from .assets import asset_fingerprint

        # ComfyUI already hashes the complete project STRING and upstream links.
        # This fingerprint adds files outside the graph; it must stay stable for
        # unchanged inputs so text encodings and unaffected scenes can be reused.
        # Uploaded assets are immutable. Also invalidate after a local file edit.
        return tuple((json.dumps(asset, sort_keys=True), *asset_fingerprint(asset))
                     for asset in project_assets(parse_project(project)))

    def generate(self, model, clip, video_vae, audio_vae, project, prompt=None):
        from comfy_execution.graph_utils import GraphBuilder
        from .assets import open_asset

        project = parse_project(project)
        validate_generation_audio(project)
        for asset in project_assets(project):
            try:
                with open_asset(asset):
                    pass
            except FileNotFoundError:
                raise ValidationError(f"Media file is missing: {asset['filename']}") from None
            except OSError:
                raise ValidationError(f"Cannot access media file: {asset['filename']}") from None
        graph, video = compile_project(project, model=model, clip=clip,
                                      video_vae=video_vae, audio_vae=audio_vae,
                                      prefix=GraphBuilder().prefix, prompt=prompt)
        return {"result": (video,), "expand": graph}


class HappyLatentFreezeAudioLatent:
    @classmethod
    def INPUT_TYPES(cls):
        return {"required": {"latent": ("LATENT",)}}

    RETURN_TYPES = ("LATENT",)
    FUNCTION = "freeze"
    CATEGORY = "HappyLatent/internal"
    # Expansion helpers stay available to execution without cluttering Add Node.
    DEPRECATED = True

    def freeze(self, latent):
        import torch
        frozen = dict(latent)
        frozen["noise_mask"] = torch.zeros_like(latent["samples"])
        return (frozen,)


class HappyLatentAudioConditioning:
    @classmethod
    def INPUT_TYPES(cls):
        return {"required": {"plan": ("STRING",), "samples": ("INT", {"min": 1, "max": 29184000}), "audio_vae": ("VAE",)}}

    RETURN_TYPES = ("AUDIO",)
    FUNCTION = "prepare"
    CATEGORY = "HappyLatent/internal"
    # Expansion helpers stay available to execution without cluttering Add Node.
    DEPRECATED = True

    @classmethod
    def IS_CHANGED(cls, plan, **kwargs):
        from .assets import asset_fingerprint
        from .audio_nodes import MAX_PREPARED_SAMPLES, parse_audio_json, validate_regions
        samples = _integer(kwargs.get("samples", MAX_PREPARED_SAMPLES), "Prepared audio samples", 0, MAX_PREPARED_SAMPLES)
        regions = validate_regions(parse_audio_json(plan), samples=samples)
        return tuple(asset_fingerprint(region["asset"])
                     for region in regions if region["kind"] == "file")

    def prepare(self, plan, samples, audio_vae):
        import torch
        from .audio_nodes import file_pcm, parse_audio_json
        from .audio_plan import SAMPLE_RATE
        waveform = torch.from_numpy(file_pcm(parse_audio_json(plan), samples)).unsqueeze(0)
        rate = audio_vae.audio_sample_rate
        if rate != SAMPLE_RATE:
            import comfy.audio
            waveform = comfy.audio.resample(waveform, SAMPLE_RATE, rate)
        if audio_vae.crop_input:
            # Native VAE.encode otherwise center-crops audio to its input grid,
            # shifting supplied conditioning relative to the timeline mask.
            block = audio_vae.spacial_compression_encode()
            waveform = torch.nn.functional.pad(waveform, (0, (-waveform.shape[-1]) % block))
        return ({"waveform": waveform, "sample_rate": rate},)


class HappyLatentAudioMask:
    @classmethod
    def INPUT_TYPES(cls):
        from .audio_nodes import MAX_PREPARED_SAMPLES
        return {"required": {"latent": ("LATENT",), "plan": ("STRING",), "audio_vae": ("VAE",)},
                "optional": {"authored_samples": ("INT", {"default": 0, "min": 0, "max": MAX_PREPARED_SAMPLES})}}

    RETURN_TYPES = ("LATENT",)
    FUNCTION = "mask"
    CATEGORY = "HappyLatent/internal"
    # Expansion helpers stay available to execution without cluttering Add Node.
    DEPRECATED = True

    def mask(self, latent, plan, audio_vae, authored_samples=0):
        from .audio_nodes import mask_audio, parse_audio_json
        return (mask_audio(latent, parse_audio_json(plan), audio_vae, authored_samples),)


class HappyLatentEmptyAudioLatent:
    @classmethod
    def INPUT_TYPES(cls):
        return {"required": {
            "frames_number": ("INT", {"min": 1, "max": model_length(MAX_SCENE_SECONDS * 60)}),
            "frame_rate": ("INT", {"min": 1, "max": 60}),
            "batch_size": ("INT", {"min": 1, "max": 1}),
            "audio_vae": ("VAE",),
        }}

    RETURN_TYPES = ("LATENT",)
    FUNCTION = "create"
    CATEGORY = "HappyLatent/internal"
    # Expansion helpers stay available to execution without cluttering Add Node.
    DEPRECATED = True

    def create(self, frames_number, frame_rate, batch_size, audio_vae):
        from comfy_extras.nodes_lt_audio import LTXVEmptyLatentAudio
        _integer(frames_number, "Audio frames", 1, model_length(MAX_SCENE_SECONDS * 60))
        _integer(frame_rate, "Audio FPS", 1, 60)
        _integer(batch_size, "Audio batch size", 1, 1)
        return (LTXVEmptyLatentAudio.execute(frames_number, frame_rate, batch_size, audio_vae)[0],)


class HappyLatentDecode:
    @classmethod
    def INPUT_TYPES(cls):
        return {"required": {"samples": ("LATENT",), "vae": ("VAE",)}}

    RETURN_TYPES = ("IMAGE",)
    FUNCTION = "decode"
    CATEGORY = "HappyLatent/internal"
    # Expansion helpers stay available to execution without cluttering Add Node.
    DEPRECATED = True

    def decode(self, samples, vae):
        import nodes

        # Full CUDA decoding avoids temporal tile seams; ComfyUI handles its
        # recognized OOM errors. Keep the bounded path on other backends.
        if getattr(getattr(vae, "device", None), "type", None) == "cuda":
            return nodes.VAEDecode().decode(vae, samples)
        return nodes.VAEDecodeTiled().decode(
            vae, samples, tile_size=512, overlap=64,
            temporal_size=64, temporal_overlap=16)


class HappyLatentTrimFrames:
    @classmethod
    def INPUT_TYPES(cls):
        return {"required": {"images": ("IMAGE",), "frames": ("INT", {"min": 1, "max": 3600, "default": 49})}}

    RETURN_TYPES = ("IMAGE",)
    FUNCTION = "trim"
    CATEGORY = "HappyLatent/internal"
    # Expansion helpers stay available to execution without cluttering Add Node.
    DEPRECATED = True

    def trim(self, images, frames):
        if len(images) < frames:
            raise ValidationError(f"Model returned {len(images)} frames; {frames} were required.")
        return (images[:frames].clone(),)


class HappyLatentLoadImage:
    @classmethod
    def INPUT_TYPES(cls):
        return {"required": {"asset": ("STRING",)}}

    RETURN_TYPES = ("IMAGE",)
    FUNCTION = "load_image"
    CATEGORY = "HappyLatent/internal"
    # Expansion helpers stay available to execution without cluttering Add Node.
    DEPRECATED = True

    @classmethod
    def VALIDATE_INPUTS(cls, asset):
        from .images import parse_image_asset, validate_reference_image
        try:
            validate_reference_image(parse_image_asset(asset))
        except ValidationError as error:
            return str(error)
        return True

    @classmethod
    def IS_CHANGED(cls, asset):
        from .images import parse_image_asset, reference_image_fingerprint
        return reference_image_fingerprint(parse_image_asset(asset))

    def load_image(self, asset):
        from .images import load_reference_image, parse_image_asset
        return (load_reference_image(parse_image_asset(asset)),)


class HappyLatentImageCrop:
    @classmethod
    def INPUT_TYPES(cls):
        return {"required": {
            "image": ("IMAGE",),
            "width": ("INT", {"default": 1024, "min": 64, "max": 4096, "step": 32}),
            "height": ("INT", {"default": 576, "min": 64, "max": 4096, "step": 32}),
            "x": ("FLOAT", {"default": 0.5, "min": 0, "max": 1}),
            "y": ("FLOAT", {"default": 0.5, "min": 0, "max": 1}),
        }, "optional": {"scale": ("FLOAT", {"default": 1, "min": 0.1, "max": 1})}}

    RETURN_TYPES = ("IMAGE",)
    FUNCTION = "crop"
    CATEGORY = "HappyLatent/internal"
    # Expansion helpers stay available to execution without cluttering Add Node.
    DEPRECATED = True

    def crop(self, image, width, height, x, y, scale=1):
        from torch.nn.functional import interpolate
        from .crop import crop_rectangle

        if image.ndim != 4 or image.shape[0] < 1 or image.shape[-1] < 3:
            raise ValidationError("Reference image must contain a batch of RGB pixels.")
        left, top, retained_width, retained_height = crop_rectangle(
            image.shape[2], image.shape[1], width, height, x, y, scale)
        retained = image[:, top:top + retained_height, left:left + retained_width, :]
        # Exact output dimensions prevent the conditioning node cropping again.
        # Interpolation allocates fresh storage; the uploaded image stays intact.
        return (interpolate(retained.movedim(-1, 1), size=(height, width),
                            mode="bilinear", align_corners=False).movedim(1, -1),)


class HappyLatentSceneVideo:
    @classmethod
    def INPUT_TYPES(cls):
        return {"required": {"images": ("IMAGE",), "fps": ("INT", {"min": 1, "max": 60, "default": 24})}}

    RETURN_TYPES = ("VIDEO",)
    FUNCTION = "encode"
    CATEGORY = "HappyLatent/internal"
    # Expansion helpers stay available to execution without cluttering Add Node.
    DEPRECATED = True

    def encode(self, images, fps):
        from fractions import Fraction
        from io import BytesIO
        from comfy_api.latest import InputImpl, Types

        video = InputImpl.VideoFromComponents(Types.VideoComponents(images=images, frame_rate=Fraction(fps)))
        buffer = BytesIO()
        # ComfyUI's automatic tensor concatenation uses MKV's millisecond clock.
        # MP4 preserves each frame's rational timestamp before joining scenes.
        # The buffer belongs to VIDEO; only the workflow's Save Video writes disk.
        # This preset disables B-frame reordering. Default H.264 can use a
        # different decode delay for short scenes, causing overlapping DTS at
        # cuts when ConcatenateVideo remuxes unequal scene lengths.
        video.save_to(buffer, format=Types.VideoContainer.MP4, codec=Types.VideoCodec.H264,
                      preset="ultrafast")
        buffer.seek(0)
        return (InputImpl.VideoFromFile(buffer),)


class HappyLatentAudioSegment:
    @classmethod
    def INPUT_TYPES(cls):
        return {"required": {
            "asset": ("STRING",),
            "fps": ("INT", {"default": 24, "min": 1, "max": 60}),
            "start_frame": ("INT", {"default": 0, "min": 0, "max": 60 * MAX_TIMELINE_SECONDS}),
            "frames": ("INT", {"default": 49, "min": 1, "max": 3608}),
            "offset_frames": ("INT", {"default": 0, "min": 0, "max": 60 * MAX_TIMELINE_SECONDS}),
            "trim_start_frames": ("INT", {"default": 0, "min": 0, "max": 36000}),
        }}

    RETURN_TYPES = ("AUDIO",)
    FUNCTION = "prepare"
    CATEGORY = "HappyLatent/internal"
    # Expansion helpers stay available to execution without cluttering Add Node.
    DEPRECATED = True

    @classmethod
    def IS_CHANGED(cls, asset, **kwargs):
        from .assets import asset_fingerprint
        from .audio_nodes import parse_audio_json
        return asset_fingerprint(parse_audio_json(asset))

    def prepare(self, asset, fps, start_frame, frames, offset_frames, trim_start_frames):
        import torch
        from .assets import open_asset
        from .audio_nodes import parse_audio_json
        from .media import SAMPLE_RATE, decode_audio

        fps = _integer(fps, "Audio FPS", 1, 60)
        start_frame = _integer(start_frame, "Audio start", 0, fps * MAX_TIMELINE_SECONDS)
        # Keep serialized legacy preparation nodes compatible. New editor
        # generations enforce their shorter scene limit in validate_project.
        frames = _integer(frames, "Audio frames", 1, fps * 60 + 8)
        offset_frames = _integer(offset_frames, "Audio offset", 0, fps * MAX_TIMELINE_SECONDS)
        trim_start_frames = _integer(trim_start_frames, "Audio trim", 0, fps * 600)
        reference = parse_audio_json(asset)
        # Round absolute timeline boundaries, so adjacent scene slices exactly
        # match the complete soundtrack even when samples/frame is fractional.
        start_sample = round(start_frame * SAMPLE_RATE / fps)
        end_sample = round((start_frame + frames) * SAMPLE_RATE / fps)
        offset_sample = round(offset_frames * SAMPLE_RATE / fps)
        trim_sample = round(trim_start_frames * SAMPLE_RATE / fps)
        source_start = start_sample - offset_sample + trim_sample
        with open_asset(reference) as source:
            samples = decode_audio(source, start_seconds=source_start / SAMPLE_RATE,
                                   duration_seconds=(end_sample - start_sample) / SAMPLE_RATE)
        # A positive source trim must never introduce audio before its placement.
        before_clip = max(0, offset_sample - start_sample)
        samples[:, :min(samples.shape[1], before_clip)] = 0
        return ({"waveform": torch.from_numpy(samples).unsqueeze(0), "sample_rate": SAMPLE_RATE},)


NODE_CLASS_MAPPINGS = {
    "HappyLatentVideo": HappyLatentVideo,
    "HappyLatentFreezeAudioLatent": HappyLatentFreezeAudioLatent,
    "HappyLatentDecode": HappyLatentDecode,
    "HappyLatentTrimFrames": HappyLatentTrimFrames,
    "HappyLatentLoadImage": HappyLatentLoadImage,
    "HappyLatentImageCrop": HappyLatentImageCrop,
    "HappyLatentSceneVideo": HappyLatentSceneVideo,
    "HappyLatentAudioSegment": HappyLatentAudioSegment,
    "HappyLatentAudioConditioning": HappyLatentAudioConditioning,
    "HappyLatentAudioMask": HappyLatentAudioMask,
    "HappyLatentEmptyAudioLatent": HappyLatentEmptyAudioLatent,
}
NODE_DISPLAY_NAME_MAPPINGS = {
    "HappyLatentVideo": "HappyLatentVideo",
    "HappyLatentFreezeAudioLatent": "HappyLatent: Preserve Custom Audio",
    "HappyLatentDecode": "HappyLatent: Decode Video",
    "HappyLatentTrimFrames": "HappyLatent: Trim Frames",
    "HappyLatentLoadImage": "HappyLatent: Load Reference Image",
    "HappyLatentImageCrop": "HappyLatent: Reference Image Crop",
    "HappyLatentSceneVideo": "HappyLatent: Clip Video",
    "HappyLatentAudioSegment": "HappyLatent: Audio Segment",
    "HappyLatentAudioConditioning": "HappyLatent: Audio Conditioning",
    "HappyLatentAudioMask": "HappyLatent: Audio Generation Mask",
    "HappyLatentEmptyAudioLatent": "HappyLatent: Empty Audio Latent",
    "HappyLatentAudioMix": "HappyLatent: Complete Soundtrack",
}

try:
    from .audio_nodes import native_mix_node
    NODE_CLASS_MAPPINGS["HappyLatentAudioMix"] = native_mix_node()
except ModuleNotFoundError as error:
    if error.name != "comfy_api":
        raise
