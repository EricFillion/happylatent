"""Pure project-to-ComfyUI expansion; model weights are loaded by native nodes."""
from __future__ import annotations

import json

from .project import ValidationError, assemble_scene_prompt, get_image_strength, get_sampling, model_length, scene_ranges, validate_generation_audio, validate_project
from .audio_plan import audio_regions, conditioning_regions, frame_sample, scene_audio_plan
from .sampling import resolve_sampling_preset
from .temporal import TEMPORAL_SIGMAS, compile_temporal_refinement

# ComfyUI's distilled base-generation schedule.
DISTILLED_SIGMAS = "1, 0.99375, 0.9875, 0.98125, 0.975, 0.909375, 0.725, 0.421875, 0"
# Conservative standalone polish uses only the final distilled denoising step.
REFINE_SIGMAS = "0.421875, 0"
UPSCALE_SIGMAS = "0.85, 0.7250, 0.4219, 0.0"
UPSCALE_MODES = ("spatial", "temporal", "spatial+temporal")
SPATIAL_UPSCALE_MODEL_NAME = "ltx-2.5-latent-spatial-upscaler-x2-bf16-1.0.safetensors"
TEMPORAL_UPSCALE_MODEL_NAME = "ltx-2.5-latent-temporal-upscaler-x2-bf16-1.0.safetensors"
NO_UPSCALE_MODEL = "none"


def validate_upscale_options(upscale_enabled, upscale_model, upscale_mode="spatial", temporal_upscale_model=None,
                             spatial_upscale_model_name=NO_UPSCALE_MODEL, temporal_upscale_model_name=NO_UPSCALE_MODEL,
                             available_model_names=None):
    if not isinstance(upscale_enabled, bool):
        raise ValidationError("Upscale 2x must be on or off.")
    if upscale_mode not in UPSCALE_MODES:
        raise ValidationError("Upscale mode must be spatial, temporal, or spatial+temporal.")
    if not upscale_enabled:
        return
    selected = []
    if upscale_mode in ("spatial", "spatial+temporal"):
        selected.append(("upscale_model", "spatial", upscale_model, spatial_upscale_model_name))
    if upscale_mode in ("temporal", "spatial+temporal"):
        selected.append(("temporal_upscale_model", "temporal", temporal_upscale_model, temporal_upscale_model_name))
    for name, kind, link, filename in selected:
        if link is not None:
            if (not isinstance(link, list) or len(link) != 2
                or not isinstance(link[0], str) or not link[0]
                or isinstance(link[1], bool) or not isinstance(link[1], int) or link[1] < 0):
                raise ValidationError(f"Connect the {name} input to a valid LTX 2.5 {kind} 2x latent upscaler loader.")
            # Existing workflows may supply any compatible model through a
            # raw link. That explicit connection overrides the filename widget.
            continue
        if not isinstance(filename, str) or not filename.strip() or filename == NO_UPSCALE_MODEL:
            raise ValidationError(f"Connect the {name} input or select a {kind} upscale model, or turn {kind} upscaling off.")
        basename = filename.replace("\\", "/").rsplit("/", 1)[-1].lower()
        wrong_official = TEMPORAL_UPSCALE_MODEL_NAME if kind == "spatial" else SPATIAL_UPSCALE_MODEL_NAME
        if basename == wrong_official.lower():
            raise ValidationError(f"The selected model is the official {'temporal' if kind == 'spatial' else 'spatial'} upscaler. Select a {kind} upscale model.")
        if available_model_names is not None and filename not in available_model_names:
            raise ValidationError(f"The selected {kind} upscale model is unavailable: {filename}. Install it in latent_upscale_models or select another model.")


def validate_refine_options(refine_enabled):
    if refine_enabled is not None and not isinstance(refine_enabled, bool):
        raise ValidationError("Refine output must be on or off.")


def compile_project(project, *, model, clip, video_vae, audio_vae, prefix="", prompt=None,
                    upscale_enabled=False, upscale_model=None, upscale_mode="spatial", temporal_upscale_model=None,
                    spatial_upscale_model_name=NO_UPSCALE_MODEL, temporal_upscale_model_name=NO_UPSCALE_MODEL,
                    refine_enabled=None):
    """Return (expanded graph, VIDEO link), leaving external links untouched.

    The caller provides a ComfyUI GraphBuilder prefix to isolate each expansion.
    The optional API prompt identifies the connected model for Auto sampling.
    No filesystem outputs or independent job queue live here.
    """
    project = validate_project(project)
    validate_generation_audio(project)
    validate_upscale_options(upscale_enabled, upscale_model, upscale_mode, temporal_upscale_model,
                             spatial_upscale_model_name, temporal_upscale_model_name)
    validate_refine_options(refine_enabled)
    spatial_upscale = upscale_enabled and upscale_mode in ("spatial", "spatial+temporal")
    temporal_upscale = upscale_enabled and upscale_mode in ("temporal", "spatial+temporal")
    # Upscaling always requires refinement, including legacy/API requests
    # with an explicit false manual preference.
    spatial_refine = spatial_upscale
    standalone_refine = refine_enabled is True and not (spatial_upscale or temporal_upscale)
    output_fps = project["fps"] * (2 if temporal_upscale else 1)
    for name, link in (("model", model), ("clip", clip), ("video_vae", video_vae), ("audio_vae", audio_vae)):
        if (not isinstance(link, list) or len(link) != 2 or not isinstance(link[0], str)
                or isinstance(link[1], bool) or not isinstance(link[1], int) or link[1] < 0):
            raise ValidationError(f"Connect the {name} input to its ComfyUI loader node.")
    preset = resolve_sampling_preset(project, model=model, prompt=prompt)
    graph = {}

    def node(key, kind, **inputs):
        identifier = prefix + key
        # Links are mutable [node_id, socket] arrays. Every graph input owns its
        # link so host rewiring cannot alter callers, sibling nodes or another
        # expansion that was compiled from the same external loader links.
        graph[identifier] = {"class_type": kind, "inputs": {
            name: value.copy() if isinstance(value, list) else value
            for name, value in inputs.items()
        }}
        return [identifier, 0]

    # One shared loader per selected stage, created only when no legacy model
    # link overrides it. OFF never produces either loader or requires a filename.
    if spatial_upscale and upscale_model is None:
        upscale_model = node("upscale_model_loader", "LatentUpscaleModelLoader", model_name=spatial_upscale_model_name)
    if temporal_upscale and temporal_upscale_model is None:
        temporal_upscale_model = node("temporal_upscale_model_loader", "LatentUpscaleModelLoader", model_name=temporal_upscale_model_name)

    samplers = {}
    distilled_sigmas = None
    upscale_sampler = None
    upscale_sigmas = None
    temporal_sampler = None
    temporal_sigmas = None
    refine_sampler = None
    refine_sigmas = None
    videos = []
    generated_audio = {}
    generated_plan = []
    for index, item in enumerate(scene_ranges(project)):
        scene = item["scene"]
        sampling = get_sampling(project, scene, resolved_preset=preset)
        sampler_name = sampling["sampler"]
        if sampler_name not in samplers:
            key = "sampler" if not samplers else f"sampler_{len(samplers)}"
            samplers[sampler_name] = node(key, "KSamplerSelect", sampler_name=sampler_name)
        sampler = samplers[sampler_name]
        length = model_length(scene["durationFrames"])
        stem = f"scene_{index}_"

        def scene_node(key, kind, **inputs):
            return node(stem + key, kind, **inputs)

        scene_prompt = assemble_scene_prompt(project, scene)
        positive = scene_node("positive", "CLIPTextEncode", text=scene_prompt, clip=clip)
        negative = scene_node("negative", "ConditioningZeroOut", conditioning=positive)
        conditioning = scene_node("conditioning", "LTXVConditioning", positive=positive, negative=negative, frame_rate=project["fps"])
        positive, negative = conditioning, [conditioning[0], 1]
        video = scene_node("video_latent", "EmptyLTXVLatentVideo", width=project["width"], height=project["height"], length=length, batch_size=1)
        if scene.get("image"):
            image = scene["image"]
            pixels = scene_node("image", "HappyLatentLoadImage", asset=json.dumps(image, sort_keys=True))
            pixels = scene_node("frame", "ImageFromBatch", image=pixels, batch_index=0, length=1)
            crop = scene.get("crop", {"x": 0.5, "y": 0.5})
            pixels = scene_node("crop", "HappyLatentImageCrop", image=pixels,
                                width=project["width"], height=project["height"], **crop)
            video = scene_node("image_conditioning", "LTXVImgToVideoInplace", vae=video_vae, image=pixels, latent=video, strength=get_image_strength(project, scene, "first"), bypass=False)
        # The model's shift depends on video tokens, not the concatenated audio/video latent.
        if sampling["scheduler"] == "distilled":
            if distilled_sigmas is None:
                distilled_sigmas = node("schedule", "ManualSigmas", sigmas=DISTILLED_SIGMAS)
            sigmas = distilled_sigmas
        else:
            sigmas = scene_node("schedule", "LTXVScheduler", steps=sampling["steps"],
                                max_shift=2.05, base_shift=0.95, stretch=True,
                                terminal=0.1, latent=video)
        if scene.get("endImage"):
            image = scene["endImage"]
            pixels = scene_node("end_image", "HappyLatentLoadImage", asset=json.dumps(image, sort_keys=True))
            pixels = scene_node("end_frame", "ImageFromBatch", image=pixels, batch_index=0, length=1)
            crop = scene.get("endCrop", {"x": 0.5, "y": 0.5})
            pixels = scene_node("end_crop", "HappyLatentImageCrop", image=pixels,
                                width=project["width"], height=project["height"], **crop)
            guide = scene_node("end_guide", "LTXVAddGuide", positive=positive, negative=negative,
                               vae=video_vae, latent=video, image=pixels,
                               frame_idx=scene["durationFrames"] - 1, strength=get_image_strength(project, scene, "last"))
            positive, negative, video = guide, [guide[0], 1], [guide[0], 2]
        plan = scene_audio_plan(project, item["startFrame"], scene["durationFrames"])
        has_files = any(region["kind"] == "file" for region in plan)
        generated = [region for region in plan if region["kind"] == "generate"]
        # Older projects guide video with every provided file. An explicit opt
        # out changes only the scene's sampling path, never soundtrack timing.
        guide_with_files = has_files and scene.get("audioGuidance", True)
        uses_audio_latent = guide_with_files or bool(generated)
        if guide_with_files:
            samples = frame_sample(item["startFrame"] + length, project["fps"]) - frame_sample(item["startFrame"], project["fps"])
            audio = scene_node("source_audio", "HappyLatentAudioConditioning",
                               plan=json.dumps([region for region in plan if region["kind"] == "file"], sort_keys=True),
                               samples=samples, audio_vae=audio_vae)
            latent = scene_node("encoded_audio", "LTXVAudioVAEEncode", audio=audio, audio_vae=audio_vae)
        elif generated:
            # The native node caps frames_number at 1000 even though its runtime
            # supports our 1201-frame maximum. Use our wider schema only above
            # that boundary, leaving ordinary generations unchanged.
            kind = "LTXVEmptyLatentAudio" if length <= 1000 else "HappyLatentEmptyAudioLatent"
            latent = scene_node("empty_audio", kind, frames_number=length, frame_rate=project["fps"], batch_size=1, audio_vae=audio_vae)
        if uses_audio_latent:
            authored_samples = frame_sample(item["endFrame"], project["fps"]) - frame_sample(item["startFrame"], project["fps"])
            audio_latent = scene_node("fixed_audio", "HappyLatentAudioMask", latent=latent,
                                     plan=json.dumps(conditioning_regions(plan, authored_samples), sort_keys=True), audio_vae=audio_vae)
            latent = scene_node("av_latent", "LTXVConcatAVLatent", video_latent=video, audio_latent=audio_latent)
        else:
            latent = video
        sampled = scene_node("sample", "SamplerCustom", model=model, add_noise=True, noise_seed=(project["seed"] + index) % (2**53), cfg=sampling["cfg"], positive=positive, negative=negative, sampler=sampler, sigmas=sigmas, latent_image=latent)
        video = scene_node("separate", "LTXVSeparateAVLatent", av_latent=sampled) if uses_audio_latent else sampled
        temporal_source_audio = [video[0], 1] if uses_audio_latent else None
        if generated:
            key = f"audio{index}"
            generated_audio[f"generated.{key}"] = scene_node("audio_decode", "LTXVAudioVAEDecode",
                samples=[video[0], 1], audio_vae=audio_vae)
            generated_plan.append({"key": key, "origin": frame_sample(item["startFrame"], project["fps"]), "regions": generated})
        if scene.get("endImage"):
            cropped = scene_node("crop_guides", "LTXVCropGuides", positive=positive, negative=negative, latent=video)
            video = [cropped[0], 2]
            positive, negative = cropped, [cropped[0], 1]
        if spatial_upscale:
            # Keep generation and audio nodes unchanged so the same scene
            # latents can be reused when the output resolution is toggled.
            video = scene_node("upscale", "LTXVLatentUpsampler", samples=video,
                               upscale_model=upscale_model, vae=video_vae)
            if spatial_refine:
                if upscale_sampler is None:
                    upscale_sampler = node("upscale_sampler", "KSamplerSelect", sampler_name="euler_ancestral")
                    upscale_sigmas = node("upscale_schedule", "ManualSigmas", sigmas=UPSCALE_SIGMAS)
                guider = scene_node("upscale_guider", "LTXVDualCFGGuider", model=model,
                                    positive=positive, negative=negative, video_cfg=1.0, audio_cfg=1.0)
                noise = scene_node("upscale_noise", "RandomNoise", noise_seed=(project["seed"] + index + 1) % (2**53))
                video = scene_node("upscale_refine", "SamplerCustomAdvanced", noise=noise, guider=guider,
                                   sampler=upscale_sampler, sigmas=upscale_sigmas, latent_image=video)
        if standalone_refine:
            # A conservative same-canvas pass, independent of all upscaler inputs.
            # The base graph and final soundtrack retain their original ancestry.
            if refine_sampler is None:
                refine_sampler = node("refine_sampler", "KSamplerSelect", sampler_name="euler")
                refine_sigmas = node("refine_schedule", "ManualSigmas", sigmas=REFINE_SIGMAS)
            if scene.get("endImage"):
                guide = scene_node("refine_end_guide", "LTXVAddGuide", positive=positive, negative=negative,
                    vae=video_vae, latent=video, image=[prefix + stem + "end_crop", 0],
                    frame_idx=scene["durationFrames"] - 1, strength=get_image_strength(project, scene, "last"))
                positive, negative, video = guide, [guide[0], 1], [guide[0], 2]
            if temporal_source_audio is not None:
                frozen = scene_node("refine_audio", "HappyLatentFreezeAudioLatent", latent=temporal_source_audio)
                video = scene_node("refine_av", "LTXVConcatAVLatent", video_latent=video, audio_latent=frozen)
            guider = scene_node("refine_guider", "LTXVDualCFGGuider", model=model,
                positive=positive, negative=negative, video_cfg=sampling["cfg"], audio_cfg=1.0)
            noise = scene_node("refine_noise", "RandomNoise", noise_seed=(project["seed"] + index + 2000) % (2**53))
            video = scene_node("refine", "SamplerCustomAdvanced", noise=noise, guider=guider,
                sampler=refine_sampler, sigmas=refine_sigmas, latent_image=video)
            if temporal_source_audio is not None:
                video = scene_node("refine_separate", "LTXVSeparateAVLatent", av_latent=video)
            if scene.get("endImage"):
                crop = scene_node("refine_crop_guides", "LTXVCropGuides", positive=positive, negative=negative, latent=video)
                video = [crop[0], 2]
        if temporal_upscale:
            # Raw temporal interpolation is an intermediate. Always refine with
            # frozen source-frame guides and carried window prefixes. This is a
            # source-preserving DFR adaptation, not the complete DFR pipeline.
            if temporal_sampler is None:
                temporal_sampler = node("temporal_sampler", "SamplerEulerAncestral", eta=0.5, s_noise=1.0)
                temporal_sigmas = node("temporal_schedule", "ManualSigmas", sigmas=TEMPORAL_SIGMAS)
            source = video
            upscaled = scene_node("temporal_upscale", "LTXVLatentUpsampler", samples=source,
                                  upscale_model=temporal_upscale_model, vae=video_vae)
            video = compile_temporal_refinement(scene_node, source=source, upscaled=upscaled,
                source_audio=temporal_source_audio, source_frames=length, fps=project["fps"],
                seed=(project["seed"] + index) % 2**53,
                positive=[prefix + stem + "positive", 0], negative=[prefix + stem + "negative", 0],
                model=model, vae=video_vae, sampler=temporal_sampler, sigmas=temporal_sigmas)
        images = scene_node("decode", "HappyLatentDecode", samples=video, vae=video_vae)
        trim_options = {"frames": scene["durationFrames"]}
        if temporal_upscale:
            # Temporal upsampling decodes to 2*model_length-1 frames. A scene
            # already on the 8k+1 grid needs one final hold frame for exact duration.
            trim_options = {"frames": 2 * scene["durationFrames"], "pad_last_frame": True}
        images = scene_node("trim", "HappyLatentTrimFrames", images=images, **trim_options)
        videos.append(scene_node("video", "HappyLatentSceneVideo", images=images, fps=output_fps))

    inputs = {f"videos.video{index}": video for index, video in enumerate(videos)}
    regions = audio_regions(project)
    if regions:
        total = sum(scene["durationFrames"] for scene in project["scenes"])
        mix = {"samples": frame_sample(total, project["fps"]), "regions": regions, "generated": generated_plan}
        inputs["complete_audio"] = node("soundtrack", "HappyLatentAudioMix", plan=json.dumps(mix, sort_keys=True), **generated_audio)
    result = node("sequence", "ConcatenateVideo", codec="h264", **inputs)
    return graph, result
