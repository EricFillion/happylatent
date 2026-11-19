"""Klein 4B generation/editing using ComfyUI's native, cached model pipeline.

Connect ComfyUI model loaders to the node or use the legacy Apache-2.0 model
filenames. Schema inspection and graph compilation never download weights.
"""
from __future__ import annotations

import json

from .crop import crop_rectangle
from .project import ValidationError, validate_asset, validate_crop

MODEL_FILES = {
    "diffusion_model": ("flux-2-klein-4b.safetensors", "flux-2-klein-4b-fp8.safetensors"),
    "text_encoder": ("qwen_3_4b.safetensors",),
    "vae_name": ("flux2-vae.safetensors",),
}
MODEL_FOLDERS = {"diffusion_model": "diffusion_models", "text_encoder": "text_encoders", "vae_name": "vae"}
MODEL_PORTS = {
    "model": ("MODEL", "diffusion_model", "FLUX.2 Klein 4B Distilled model"),
    "clip": ("CLIP", "text_encoder", "FLUX.2 text encoder"),
    "vae": ("VAE", "vae_name", "FLUX.2 VAE"),
}
DEFAULT_SEED = 42
MAX_SEED = 2**53 - 1  # Also exactly representable by the browser and MCP clients.
REFERENCE_NAMES = tuple(f"reference_{i}" for i in range(1, 5))


def validate_model_filename(name, filename):
    if not isinstance(filename, str) or not filename:
        raise ValidationError(f"Select the installed Klein 4B {name} component.")
    parts = filename.replace("\\", "/").split("/")
    if any(part in ("", ".", "..") or ":" in part for part in parts) or parts[-1] not in MODEL_FILES[name]:
        raise ValidationError(f"Unsupported {name}: select an official Klein 4B component ({', '.join(MODEL_FILES[name])}).")
    return filename


def model_choices(name):
    try:
        import folder_paths
    except ModuleNotFoundError as error:
        if error.name != "folder_paths":
            raise
        return []
    choices = []
    for filename in folder_paths.get_filename_list(MODEL_FOLDERS[name]):
        try:
            validate_model_filename(name, filename)
            choices.append(filename)
        except ValidationError:
            continue
    # Prefer BF16 when available, including when files live in subdirectories.
    return sorted(set(choices), key=lambda value: (MODEL_FILES[name].index(value.replace("\\", "/").rsplit("/", 1)[-1]), value))


def _is_node_link(value):
    return (isinstance(value, list) and len(value) == 2 and isinstance(value[0], str) and bool(value[0])
            and isinstance(value[1], int) and not isinstance(value[1], bool) and value[1] >= 0)


def _validate_model_sources(values, *, preflight=False):
    for port, (_, filename_input, label) in MODEL_PORTS.items():
        link, filename = values[port], values[filename_input]
        if link is not None:
            if not _is_node_link(link):
                raise ValidationError(f"Connect the {label} to {port}.")
            continue
        # ComfyUI supplies None for a connected filename not yet resolved.
        # An omitted legacy filename uses the empty string sentinel.
        if preflight and filename is None:
            continue
        if filename is None or filename == "":
            raise ValidationError(f"Connect the {label} to {port}.")
        validate_model_filename(filename_input, filename)
        if preflight and filename not in model_choices(filename_input):
            raise ValidationError(f"Missing {filename_input}: install {filename} in models/{MODEL_FOLDERS[filename_input]} and refresh the model list.")


def validate_klein_options(*, prompt, width, height, seed, allow_unresolved=False):
    if not (allow_unresolved and prompt is None):
        if not isinstance(prompt, str) or not prompt.strip() or len(prompt) > 16000:
            raise ValidationError("Prompt must contain text and be at most 16000 characters.")
    for name, value, minimum, maximum in (("width", width, 256, 2048), ("height", height, 256, 2048),
                                          ("seed", seed, 0, MAX_SEED)):
        if allow_unresolved and value is None:
            continue
        if isinstance(value, bool) or not isinstance(value, int) or not minimum <= value <= maximum:
            raise ValidationError(f"{name} must be an integer from {minimum} to {maximum}.")
        if name in ("width", "height") and value % 32:
            raise ValidationError(f"{name} must be a multiple of 32.")


def parse_reference_framing(value):
    if not isinstance(value, str) or len(value) > 16384:
        raise ValidationError("Reference framing must be a JSON object.")
    try:
        rows = json.loads(value)
    except (ValueError, RecursionError):
        raise ValidationError("Reference framing must be a JSON object.") from None
    if not isinstance(rows, dict) or set(rows) - set(REFERENCE_NAMES):
        raise ValidationError("Reference framing must be keyed by reference_1 through reference_4.")
    framing = {}
    for name, row in rows.items():
        if not isinstance(row, dict) or not row or set(row) - {"asset", "crop"}:
            raise ValidationError(f"Provide an asset or crop for {name}.")
        framing[name] = {}
        if "asset" in row:
            framing[name]["asset"] = validate_asset(row["asset"])
        if "crop" in row:
            framing[name]["crop"] = validate_crop(row["crop"])
    return framing


def _uploaded_assets(framing, references):
    for name, row in framing.items():
        if references.get(name) is None and "asset" in row:
            yield row["asset"]


def compile_klein(*, prompt, width=1024, height=1024, seed=0, references=None, reference_framing="{}",
                  model=None, clip=None, vae=None, diffusion_model="", text_encoder="", vae_name="", prefix=""):
    """Return the expanded graph and its one IMAGE link without loading models."""
    validate_klein_options(prompt=prompt, width=width, height=height, seed=seed)
    _validate_model_sources(locals())
    references = {} if references is None else references
    if not isinstance(references, dict) or set(references) - set(REFERENCE_NAMES):
        raise ValidationError("Supply up to four named reference images.")
    for link in references.values():
        if link is None:
            continue
        if not _is_node_link(link):
            raise ValidationError("Connect each reference to an IMAGE output.")
    framing = parse_reference_framing(reference_framing)
    graph = {}

    def node(key, kind, **inputs):
        identifier = prefix + key
        graph[identifier] = {"class_type": kind, "inputs": {
            name: value.copy() if isinstance(value, list) else value for name, value in inputs.items()
        }}
        return [identifier, 0]

    if model is None:
        model = node("model", "UNETLoader", unet_name=diffusion_model, weight_dtype="default")
    if clip is None:
        clip = node("clip", "CLIPLoader", clip_name=text_encoder, type="flux2", device="default")
    if vae is None:
        vae = node("vae", "VAELoader", vae_name=vae_name)
    conditioning = node("text", "CLIPTextEncode", clip=clip, text=prompt)
    for index, name in enumerate(REFERENCE_NAMES, 1):
        image = references.get(name)
        frame = framing.get(name, {})
        if image is None and "asset" in frame:
            image = node(f"load_{index}", "HappyLatentLoadImage", asset=json.dumps(frame["asset"], sort_keys=True))
        if image is None:
            continue
        image = node(name, "HappyLatentKleinReference", image=image,
                     width=width, height=height, **frame.get("crop", {}))
        image = node(f"resize_{index}", "ImageScaleToTotalPixels", image=image,
                     upscale_method="lanczos", megapixels=1.0, resolution_steps=16)
        latent = node(f"encode_{index}", "VAEEncode", pixels=image, vae=vae)
        conditioning = node(f"condition_{index}", "ReferenceLatent", conditioning=conditioning, latent=latent)
    guider = node("guider", "BasicGuider", model=model, conditioning=conditioning)
    sampler = node("sampler", "KSamplerSelect", sampler_name="euler")
    sigmas = node("schedule", "Flux2Scheduler", steps=4, width=width, height=height)
    empty = node("empty", "EmptyFlux2LatentImage", width=width, height=height, batch_size=1)
    noise = node("noise", "RandomNoise", noise_seed=seed)
    latent = node("sample", "SamplerCustomAdvanced", noise=noise, guider=guider,
                  sampler=sampler, sigmas=sigmas, latent_image=empty)
    image = node("decode", "VAEDecode", samples=latent, vae=vae)
    return graph, image


class HappyLatentKleinImage:
    @classmethod
    def INPUT_TYPES(cls):
        return {"required": {
            "prompt": ("STRING", {"multiline": True, "default": "A small hand carved wooden moose on a wooden desk, soft window light, detailed product photograph.", "tooltip": "Describe the image or the edit. Refer to connected images in slot order."}),
            "width": ("INT", {"default": 1024, "min": 256, "max": 2048, "step": 32, "tooltip": "Image width in pixels."}),
            "height": ("INT", {"default": 1024, "min": 256, "max": 2048, "step": 32, "tooltip": "Image height in pixels."}),
            "seed": ("INT", {"default": DEFAULT_SEED, "min": 0, "max": MAX_SEED, "control_after_generate": False}),
        }, "optional": {
            **{port: (kind, {"rawLink": True, "tooltip": f"Connect the {label}."})
               for port, (kind, _, label) in MODEL_PORTS.items()},
            **{name: (["", *model_choices(name)], {"default": ""}) for name in MODEL_FILES},
            "reference_framing": ("STRING", {"default": "{}", "tooltip": "Uploaded references and crop settings."}),
            **{name: ("IMAGE", {"rawLink": True, "tooltip": "One RGB/RGBA image. References are processed in slot order; alpha is ignored."})
               for name in REFERENCE_NAMES},
        }}

    RETURN_TYPES = ("IMAGE",)
    RETURN_NAMES = ("images",)
    FUNCTION = "generate"
    CATEGORY = "Happy Latent/internal"
    # Keep legacy graph execution; new usage is through MCP.
    DEPRECATED = True
    DESCRIPTION = "Generate one RGB image. Connect the FLUX.2 Klein 4B Distilled model, FLUX.2 text encoder, and FLUX.2 VAE. Add and frame up to four references to edit or combine them. Connect the result to Save Image or another image node."

    @classmethod
    def VALIDATE_INPUTS(cls, diffusion_model="", text_encoder="", vae_name="", prompt=None, width=None, height=None, seed=None,
                        reference_framing=None, reference_1=None, reference_2=None, reference_3=None, reference_4=None,
                        model=None, clip=None, vae=None):
        from .images import validate_reference_image

        try:
            validate_klein_options(prompt=prompt, width=width, height=height, seed=seed, allow_unresolved=True)
            _validate_model_sources(locals(), preflight=True)
            if reference_framing is not None:
                framing = parse_reference_framing(reference_framing)
                links = dict(zip(REFERENCE_NAMES, (reference_1, reference_2, reference_3, reference_4)))
                for asset in _uploaded_assets(framing, links):
                    validate_reference_image(asset)
        except ValidationError as error:
            return str(error)
        return True

    @classmethod
    def IS_CHANGED(cls, reference_framing=None, **references):
        from .assets import asset_fingerprint

        # The graph already tracks linked inputs and the framing string itself.
        # Include changes to uploaded files so expanded graphs do not stay stale.
        framing = {} if reference_framing is None else parse_reference_framing(reference_framing)
        return tuple(asset_fingerprint(asset) for asset in _uploaded_assets(framing, references))

    def generate(self, diffusion_model="", text_encoder="", vae_name="", prompt="", width=1024, height=1024,
                 seed=DEFAULT_SEED, reference_framing="{}", reference_1=None, reference_2=None, reference_3=None,
                 reference_4=None, *, model=None, clip=None, vae=None, count=None):
        from comfy_execution.graph_utils import GraphBuilder

        # ComfyUI can still resolve a removed widget if an old API graph links
        # another node to it. Accept that legacy input without using its value.
        references = dict(zip(REFERENCE_NAMES, (reference_1, reference_2, reference_3, reference_4)))
        graph, image = compile_klein(diffusion_model=diffusion_model, text_encoder=text_encoder, vae_name=vae_name,
                                     prompt=prompt, width=width, height=height, seed=seed, references=references,
                                     reference_framing=reference_framing, model=model, clip=clip, vae=vae,
                                     prefix=GraphBuilder().prefix)
        return {"result": (image,), "expand": graph}


class HappyLatentKleinReference:
    """Validate one reference and crop its source pixels before resizing."""
    @classmethod
    def INPUT_TYPES(cls):
        return {"required": {"image": ("IMAGE",)}, "optional": {
            "width": ("INT", {"min": 256, "max": 2048, "step": 32}),
            "height": ("INT", {"min": 256, "max": 2048, "step": 32}),
            "x": ("FLOAT", {"default": 0.5, "min": 0, "max": 1}),
            "y": ("FLOAT", {"default": 0.5, "min": 0, "max": 1}),
            "scale": ("FLOAT", {"default": 1, "min": 0.1, "max": 1}),
        }}

    RETURN_TYPES = ("IMAGE",)
    FUNCTION = "prepare"
    CATEGORY = "Happy Latent/internal"
    DEPRECATED = True

    def prepare(self, image, width=None, height=None, x=0.5, y=0.5, scale=1):
        import torch

        if (not isinstance(image, torch.Tensor) or image.ndim != 4 or image.shape[0] != 1
                or image.shape[-1] not in (3, 4) or min(image.shape[1:3]) < 16):
            raise ValidationError("Each Klein reference must be one RGB/RGBA IMAGE with dimensions at least 16 pixels; use separate inputs for multiple images.")
        if max(image.shape[1:3]) / min(image.shape[1:3]) >= 16384:
            raise ValidationError("Klein reference aspect ratio is too extreme to resize to one megapixel.")
        if not image.is_floating_point() or not torch.isfinite(image).all() or image.min() < 0 or image.max() > 1:
            raise ValidationError("Klein reference pixels must be finite floating-point values between 0 and 1.")
        pixels = image[..., :3]
        if width is not None or height is not None:
            left, top, retained_width, retained_height = crop_rectangle(
                image.shape[2], image.shape[1], width, height, x, y, scale)
            pixels = pixels[:, top:top + retained_height, left:left + retained_width, :]
        return (pixels,)
