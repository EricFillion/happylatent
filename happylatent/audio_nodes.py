"""Audio processing for HappyLatentVideo."""
from __future__ import annotations

import json

from .audio_plan import SAMPLE_RATE
from .project import ValidationError, _integer, validate_asset, MAX_TIMELINE_SECONDS

MAX_SOURCE_SAMPLES = SAMPLE_RATE * 600
MAX_PROJECT_SAMPLES = SAMPLE_RATE * MAX_TIMELINE_SECONDS
# Model padding adds at most eight frames, including at the minimum 1 FPS.
MAX_PREPARED_SAMPLES = SAMPLE_RATE * 68
# Independent scene decodes have no shared samples to crossfade. A short fade
# joins generated slices at zero, or meets an adjacent uploaded file sample.
GENERATED_EDGE_FADE_SAMPLES = SAMPLE_RATE // 100


def parse_audio_json(value):
    def reject_constant(_):
        raise ValidationError("Audio plan must be valid JSON.")

    try:
        return json.loads(value, parse_constant=reject_constant)
    except (json.JSONDecodeError, TypeError) as error:
        raise ValidationError("Audio plan must be valid JSON.") from error


def validate_regions(regions, *, samples=MAX_PROJECT_SAMPLES, kinds=("file", "generate")):
    if not isinstance(regions, list) or len(regions) > 100:
        raise ValidationError("Audio plan must contain at most 100 regions.")
    result = []
    for region in regions:
        if not isinstance(region, dict) or region.get("kind") not in kinds:
            raise ValidationError("Unsupported audio region.")
        start = _integer(region.get("start"), "Audio region start", 0, samples)
        end = _integer(region.get("end"), "Audio region end", 0, samples)
        if end < start:
            raise ValidationError("Audio region end cannot precede its start.")
        item = {"kind": region["kind"], "start": start, "end": end}
        if region["kind"] == "file":
            item["asset"] = validate_asset(region.get("asset"))
            # A scene offset can advance a source already trimmed by 600 seconds.
            item["source"] = _integer(region.get("source"), "Audio source offset", 0,
                                       MAX_SOURCE_SAMPLES + MAX_PROJECT_SAMPLES - (end - start))
        elif "asset" in region or "source" in region:
            raise ValidationError("Generated audio cannot contain a source file or offset.")
        result.append(item)
    return result


def validate_mix_plan(plan):
    if not isinstance(plan, dict):
        raise ValidationError("Soundtrack plan must be an object.")
    samples = _integer(plan.get("samples"), "Soundtrack samples", 0, MAX_PROJECT_SAMPLES)
    regions = validate_regions(plan.get("regions"), samples=samples)
    generated = plan.get("generated")
    if not isinstance(generated, list) or len(generated) > 100:
        raise ValidationError("Soundtrack plan must contain at most 100 generated clips.")
    scenes, keys = [], set()
    for scene in generated:
        if not isinstance(scene, dict):
            raise ValidationError("Generated audio clip must be an object.")
        key = scene.get("key")
        if not isinstance(key, str) or not key or len(key) > 128 or key in keys:
            raise ValidationError("Generated audio clip keys must be unique nonempty strings.")
        origin = _integer(scene.get("origin"), "Generated audio origin", 0, samples)
        local = validate_regions(scene.get("regions"), samples=samples - origin, kinds=("generate",))
        scenes.append({"key": key, "origin": origin, "regions": local})
        keys.add(key)
    return {"samples": samples, "regions": regions, "generated": scenes}


def file_pcm(regions, samples, *, maximum=MAX_PREPARED_SAMPLES):
    import numpy as np
    from .assets import open_asset
    from .media import decode_audio

    samples = _integer(samples, "Prepared audio samples", 0, maximum)
    regions = validate_regions(regions, samples=samples)
    output = np.zeros((2, samples), dtype=np.float32)
    for region in regions:
        if region["kind"] != "file":
            continue
        start, end = region["start"], region["end"]
        # Uploaded sources are capped at ten minutes. Leave any later timeline
        # tail silent without asking the decoder for a project-length window.
        end = min(end, start + max(0, MAX_SOURCE_SAMPLES - region["source"]))
        if end <= start:
            continue
        with open_asset(region["asset"]) as source:
            data = decode_audio(source, start_seconds=region["source"] / SAMPLE_RATE,
                                duration_seconds=(end - start) / SAMPLE_RATE)
        if not np.isfinite(data).all():
            raise ValidationError("Uploaded audio contains non-finite samples.")
        output[:, start:end] = data
    return output


def mask_audio(latent, regions, audio_vae, authored_samples=0):
    import torch

    regions = [region for region in validate_regions(regions, samples=MAX_PREPARED_SAMPLES, kinds=("generate",))
               if region["end"] > region["start"]]
    authored_samples = _integer(authored_samples, "Authored audio samples", 0, MAX_PREPARED_SAMPLES)
    if authored_samples and any(region["end"] > authored_samples for region in regions):
        raise ValidationError("Generated audio cannot extend beyond its authored clip.")
    sample_padding = authored_samples > 0 and bool(regions)
    samples = latent["samples"]
    if samples.ndim != 4:
        raise ValidationError("LTX audio latent must have batch, channel, time and frequency dimensions.")
    vae = audio_vae.first_stage_model
    # The native VAE downsamples mel time by four. Read timing from its actual
    # configuration; causal tokens start three mel steps earlier after token 0.
    rate, hop = vae.sample_rate, vae.mel_hop_length
    factor = round(rate / hop / vae.latents_per_second)
    causal_shift = factor - 1 if vae.autoencoder.is_causal else 0
    required_samples = max((r["end"] for r in regions if r["kind"] == "generate"), default=0)
    required_mel = (required_samples * rate + SAMPLE_RATE * hop - 1) // (SAMPLE_RATE * hop)
    required_tokens = (required_mel + causal_shift + factor - 1) // factor
    if required_tokens > samples.shape[2]:
        # Native EmptyLatentAudio rounds duration to tokens, but a causal VAE
        # decodes (tokens * factor - causal_shift) mel steps. Add real sampled
        # tail tokens; padding the final waveform would invent silent audio.
        samples = torch.nn.functional.pad(samples, (0, 0, 0, required_tokens - samples.shape[2]))
    mask = torch.zeros_like(samples)
    for index in range(samples.shape[2]):
        left = max(0, index * factor - causal_shift) * hop * SAMPLE_RATE
        right = max(0, (index + 1) * factor - causal_shift) * hop * SAMPLE_RATE
        # Existing encoded-silence padding must not become frozen conditioning.
        # Keep a token that straddles the authored end under its original mask.
        if ((sample_padding and left >= authored_samples * rate) or
                any(region["start"] * rate < right and region["end"] * rate > left for region in regions)):
            mask[:, :, index, :] = 1
    return dict(latent, samples=samples, noise_mask=mask)


def assemble_soundtrack(plan, generated):
    import torch

    plan = validate_mix_plan(plan)
    expected_keys = {item["key"] for item in plan["generated"]}
    if not isinstance(generated, dict) or set(generated) != expected_keys:
        raise ValidationError("Generated soundtrack inputs do not match the clip plan.")
    output = torch.from_numpy(file_pcm(plan["regions"], plan["samples"], maximum=MAX_PROJECT_SAMPLES)).unsqueeze(0)
    file_starts = {region["start"] for region in plan["regions"] if region["kind"] == "file" and region["start"] < region["end"]}
    file_ends = {region["end"] for region in plan["regions"] if region["kind"] == "file" and region["start"] < region["end"]}
    for scene in plan["generated"]:
        audio = generated[scene["key"]]
        waveform, rate = audio["waveform"], audio["sample_rate"]
        if waveform.ndim != 3 or waveform.shape[:2] != (1, 2):
            raise ValidationError("Generated audio must contain one stereo waveform.")
        if isinstance(rate, bool) or not isinstance(rate, int) or not 8000 <= rate <= 192000:
            raise ValidationError("Generated audio has an unsupported sample rate.")
        if not torch.isfinite(waveform).all():
            raise ValidationError("Generated audio contains non-finite samples.")
        waveform = waveform.to(device="cpu", dtype=torch.float32)
        if rate != SAMPLE_RATE:
            import comfy.audio
            waveform = comfy.audio.resample(waveform, rate, SAMPLE_RATE)
        if not torch.isfinite(waveform).all():
            raise ValidationError("Generated audio normalization produced non-finite samples.")
        # Adjacent blocks from the same decode are already continuous. Fade
        # only the combined interval's edges, not every editor block boundary.
        regions = []
        for region in scene["regions"]:
            if regions and regions[-1]["end"] == region["start"]:
                regions[-1]["end"] = region["end"]
            else:
                regions.append(region.copy())
        for region in regions:
            left, right = region["start"], region["end"]
            # Native causal decoding can end before nominal duration. No
            # unexplained missing samples are silently substituted with zeros.
            if right > waveform.shape[-1]:
                raise ValidationError(f"Generated audio ends at sample {waveform.shape[-1]}; {right} samples are required.")
            destination = scene["origin"] + left
            finish = scene["origin"] + right
            before = output[:, :, destination - 1].clone() if destination in file_ends and destination else None
            after = output[:, :, finish].clone() if finish in file_starts and finish < plan["samples"] else None
            piece = output[:, :, destination:finish]
            piece[:] = waveform[:, :, left:right]
            fade = min(GENERATED_EDGE_FADE_SAMPLES, (right - left) // 2)
            if fade:
                ramp = torch.arange(fade, dtype=piece.dtype, device=piece.device) / fade
                piece[:, :, :fade] *= ramp
                if before is not None:
                    piece[:, :, :fade] += before.unsqueeze(-1) * (1 - ramp)
                piece[:, :, -fade:] *= ramp.flip(0)
                if after is not None:
                    piece[:, :, -fade:] += after.unsqueeze(-1) * (1 - ramp.flip(0))
    return {"waveform": output, "sample_rate": SAMPLE_RATE}


def native_mix_node():
    """Register the native dynamic-input schema only inside an installed host."""
    from comfy_api.latest import io

    class HappyLatentAudioMix(io.ComfyNode):
        @classmethod
        def define_schema(cls):
            return io.Schema(node_id="HappyLatentAudioMix", category="HappyLatent/internal", is_deprecated=True,
                inputs=[io.String.Input("plan"), io.Autogrow.Input("generated",
                    template=io.Autogrow.TemplatePrefix(io.Audio.Input("audio"), prefix="audio", min=0, max=100))],
                outputs=[io.Audio.Output()])

        @classmethod
        def fingerprint_inputs(cls, plan, generated=None):
            from .assets import asset_fingerprint
            plan = validate_mix_plan(parse_audio_json(plan))
            return tuple(asset_fingerprint(region["asset"])
                         for region in plan["regions"] if region["kind"] == "file")

        @classmethod
        def execute(cls, plan, generated):
            return io.NodeOutput(assemble_soundtrack(parse_audio_json(plan), generated))

    return HappyLatentAudioMix
