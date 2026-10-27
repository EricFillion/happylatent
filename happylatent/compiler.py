"""Pure project-to-ComfyUI expansion; models are links supplied by the workflow."""
from __future__ import annotations

import json

from .project import ValidationError, assemble_scene_prompt, get_image_strength, get_sampling, model_length, scene_ranges, validate_generation_audio, validate_project
from .audio_plan import audio_regions, conditioning_regions, frame_sample, scene_audio_plan
from .sampling import resolve_sampling_preset

# ComfyUI's distilled video schedule. One stage, without an upscaler.
DISTILLED_SIGMAS = "1, 0.99375, 0.9875, 0.98125, 0.975, 0.909375, 0.725, 0.421875, 0"


def compile_project(project, *, model, clip, video_vae, audio_vae, prefix="", prompt=None):
    """Return (expanded graph, VIDEO link), leaving external links untouched.

    The caller provides a ComfyUI GraphBuilder prefix to isolate each expansion.
    The optional API prompt identifies the connected model for Auto sampling.
    No filesystem outputs or independent job queue live here.
    """
    project = validate_project(project)
    validate_generation_audio(project)
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

    samplers = {}
    distilled_sigmas = None
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
        if generated:
            key = f"audio{index}"
            generated_audio[f"generated.{key}"] = scene_node("audio_decode", "LTXVAudioVAEDecode",
                samples=[video[0], 1], audio_vae=audio_vae)
            generated_plan.append({"key": key, "origin": frame_sample(item["startFrame"], project["fps"]), "regions": generated})
        if scene.get("endImage"):
            cropped = scene_node("crop_guides", "LTXVCropGuides", positive=positive, negative=negative, latent=video)
            video = [cropped[0], 2]
        images = scene_node("decode", "HappyLatentDecode", samples=video, vae=video_vae)
        images = scene_node("trim", "HappyLatentTrimFrames", images=images, frames=scene["durationFrames"])
        videos.append(scene_node("video", "HappyLatentSceneVideo", images=images, fps=project["fps"]))

    inputs = {f"videos.video{index}": video for index, video in enumerate(videos)}
    regions = audio_regions(project)
    if regions:
        total = sum(scene["durationFrames"] for scene in project["scenes"])
        mix = {"samples": frame_sample(total, project["fps"]), "regions": regions, "generated": generated_plan}
        inputs["complete_audio"] = node("soundtrack", "HappyLatentAudioMix", plan=json.dumps(mix, sort_keys=True), **generated_audio)
    result = node("sequence", "ConcatenateVideo", codec="h264", **inputs)
    return graph, result
