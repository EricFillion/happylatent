"""Read a bounded saved take for LTX spatial upscaling."""
from .assets import asset_fingerprint, open_asset
from .clips import read_clip
from .media import SAMPLE_RATE
from .project import ValidationError, model_length
from .video_media import audio_window, open_video


def source_shape(clip):
    frames, fps = clip["frameCount"], clip["fps"]
    width, height = clip["width"], clip["height"]
    if not float(fps).is_integer() or frames > fps * 20:
        raise ValidationError("Upscaling needs a take up to 20 seconds at a whole-number FPS.")
    if any(size < 64 or size > 2048 or size % 32 for size in (width, height)):
        raise ValidationError("Upscaling needs source dimensions of 64–2048 pixels in multiples of 32.")
    padded = model_length(frames)
    if padded * width * height > 96_000_000:
        raise ValidationError("This take exceeds the upscale frame budget. Import a shorter excerpt first.")
    return frames, int(fps), width, height, padded


def _take(clip_id):
    clip = read_clip(clip_id)["clip"]
    if clip["id"] != clip_id:
        raise ValidationError("Saved source clip ID does not match its record.")
    return clip


class HappyLatentLoadUpscaleSource:
    CATEGORY = "Happy Latent/internal"
    DEPRECATED = True
    FUNCTION = "load"
    RETURN_TYPES = ("IMAGE", "AUDIO")

    @classmethod
    def INPUT_TYPES(cls):
        return {"required": {"clip_id": ("STRING",)}}

    @classmethod
    def IS_CHANGED(cls, clip_id):
        clip = _take(clip_id)
        return (*source_shape(clip), clip["hasAudio"], asset_fingerprint(clip["asset"], allow_output=True))

    def load(self, clip_id):
        import torch
        from comfy.model_management import throw_exception_if_processing_interrupted

        clip = _take(clip_id)
        frames, fps, width, height, padded = source_shape(clip)
        mismatch = "Saved clip no longer matches its media. Import the clip again."
        with open_asset(clip["asset"], allow_output=True) as source:
            with open_video(source) as container:
                stream = container.streams.video[0]
                if ((stream.width, stream.height) != (width, height)
                        or stream.average_rate != fps
                        or bool(container.streams.audio) != clip["hasAudio"]):
                    raise ValidationError(mismatch)
                pixels = torch.empty((padded, height, width, 3), dtype=torch.float32, device="cpu")
                count, origin = 0, None
                for frame in container.decode(video=0):
                    throw_exception_if_processing_interrupted()
                    if count >= frames or (frame.width, frame.height) != (width, height) or frame.pts is None:
                        raise ValidationError(mismatch)
                    timestamp = frame.pts * frame.time_base
                    if origin is None:
                        origin = timestamp
                    if abs(float((timestamp - origin) * fps) - count) > 0.51:
                        raise ValidationError(mismatch)
                    pixels[count].copy_(torch.from_numpy(frame.to_ndarray(format="rgb24")))
                    count += 1
                if count != frames:
                    raise ValidationError(mismatch)
            pixels[frames:].copy_(pixels[frames - 1])
            pixels.div_(255)
            pcm = audio_window(source, start=0, seconds=frames / fps, samples=round(frames * SAMPLE_RATE / fps))
        return pixels, {"waveform": torch.from_numpy(pcm).unsqueeze(0), "sample_rate": SAMPLE_RATE}
