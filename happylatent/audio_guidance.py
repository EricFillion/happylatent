"""Extra audio/video coupling for supplied-audio LTX clips.

Uses the modality-CFG delta from Lightricks' MultiModalGuider. The auxiliary
prediction isolates the streams; the normal prediction still sees the frozen
source audio. No weights, waveform samples or shared model options are changed.
"""
from .project import _number


class HappyLatentAudioGuidance:
    @classmethod
    def INPUT_TYPES(cls):
        return {"required": {
            "model": ("MODEL",),
            "strength": ("FLOAT", {"default": 1.0, "min": 1.0, "max": 5.0, "step": 0.1,
                "tooltip": "1 keeps normal audio conditioning. Higher values add an extra model evaluation per sampling step; excessive guidance can cause artifacts."}),
        }}

    RETURN_TYPES = ("MODEL",)
    FUNCTION = "apply"
    CATEGORY = "Happy Latent/internal"
    DEPRECATED = True

    def apply(self, model, strength):
        strength = _number(strength, "Audio guidance strength", 1, 5)
        if strength == 1:
            return (model,)
        from comfy.ldm.lightricks.av_model import LTXAVModel
        from comfy.samplers import calc_cond_batch

        if not isinstance(model.get_model_object("diffusion_model"), LTXAVModel):
            raise ValueError("Audio guidance strength requires an LTX audio-video model.")
        patched = model.clone()

        def guide(args):
            options = args["model_options"].copy()
            options["transformer_options"] = {
                **options.get("transformer_options", {}),
                "a2v_cross_attn": False, "v2a_cross_attn": False,
            }
            (isolated,) = calc_cond_batch(args["model"], [args["cond"]],
                                         args["input"], args["sigma"], options)
            return args["denoised"] + (strength - 1) * (args["cond_denoised"] - isolated)

        patched.set_model_sampler_post_cfg_function(guide)
        return (patched,)
