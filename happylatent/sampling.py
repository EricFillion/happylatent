"""Conservative sampling detection from a ComfyUI API graph, without loading weights."""
from __future__ import annotations

from .project import ValidationError

# https://huggingface.co/Lightricks/LTX-2.5/tree/main/diffusion_models
# Official Lightricks/LTX-2.5 diffusion_models filenames. Exact basenames avoid
# silently classifying a fine-tune with the original model name in its prefix.
_CHECKPOINTS = {
    f"ltx-2.5-22b-{variant}-transformer-{precision}.safetensors": preset
    for variant, preset in (("distilled", "distilled"), ("dev", "full"))
    for precision in ("bf16", "comfy-int8-convrot")
} | {"ltx-2.5-22b-distilled-transformer-nvfp4.safetensors": "distilled"}
_LOADERS = {
    "UNETLoader": "unet_name",
    "CheckpointLoaderSimple": "ckpt_name",
    "CheckpointLoader": "ckpt_name",
    "UnetLoaderGGUF": "unet_name",
    "UnetLoaderGGUFAdvanced": "unet_name",
}
_LORA_LOADERS = {"LoraLoader", "LoraLoaderModelOnly", "LoraLoaderBypass", "LoraLoaderBypassModelOnly"}


def _unknown(reason):
    return {"preset": None, "reason": reason}


def _model_link(link):
    return (isinstance(link, list) and len(link) == 2 and isinstance(link[0], str)
            and bool(link[0]) and type(link[1]) is int and link[1] == 0)


def model_profile(model, prompt):
    """Resolve only known model-producing nodes and names, never arbitrary inputs.

    This is a filename hint, not weight inspection. Active LoRAs, custom model
    patches and merged/fine-tuned names require an explicit user selection.
    Traversal is iterative and bounded so malformed/cyclic graphs stay cheap.
    """
    if not isinstance(prompt, dict):
        return _unknown("Model details are unavailable. Choose Distilled or Full.")
    seen = set()
    for _ in range(128):
        if not _model_link(model):
            return _unknown("Connect a supported model loader, or choose Distilled or Full.")
        identifier = model[0]
        if identifier in seen:
            return _unknown("The model connection contains a cycle. Check the workflow.")
        seen.add(identifier)
        node = prompt.get(identifier)
        if not isinstance(node, dict) or not isinstance(node.get("inputs"), dict):
            return _unknown("Model details are unavailable. Choose Distilled or Full.")
        kind, inputs = node.get("class_type"), node["inputs"]
        if not isinstance(kind, str):
            return _unknown("Model details are unavailable. Choose Distilled or Full.")
        if kind in _LOADERS:
            name = inputs.get(_LOADERS[kind])
            if not isinstance(name, str) or len(name) > 4096:
                return _unknown("The checkpoint name is unavailable. Choose Distilled or Full.")
            basename = name.replace("\\", "/").rsplit("/", 1)[-1]
            preset = _CHECKPOINTS.get(basename.lower())
            if preset is None:
                return _unknown("Unrecognized or renamed checkpoint. Choose Distilled or Full.")
            return {"preset": preset, "checkpoint": basename,
                    "reason": "Recognized LTX 2.5 checkpoint filename."}
        if kind in _LORA_LOADERS:
            strength = inputs.get("strength_model")
            if type(strength) not in (int, float) or strength != 0:
                return _unknown("A LoRA may change the sampling recipe. Choose Distilled or Full for this setup.")
            model = inputs.get("model")
        elif kind == "ModelSamplingLTXV":
            model = inputs.get("model")
        elif kind == "Reroute":
            # Native reroutes disappear from API prompts; support explicit
            # reroutes only when their sole input is unambiguous.
            if len(inputs) != 1:
                return _unknown("The model reroute is ambiguous. Choose Distilled or Full.")
            model = next(iter(inputs.values()))
        else:
            return _unknown("Unsupported model loader or modifier. Choose Distilled or Full.")
    return _unknown("The model connection is too deep. Choose Distilled or Full.")


def resolve_sampling_preset(project, *, model, prompt=None):
    """Missing presets retain legacy controls; Auto must resolve before sampling."""
    preset = project.get("samplingPreset")
    if preset != "auto":
        return preset
    profile = model_profile(model, prompt)
    if profile["preset"] is None:
        raise ValidationError("Auto sampling could not identify this model. " + profile["reason"])
    return profile["preset"]
