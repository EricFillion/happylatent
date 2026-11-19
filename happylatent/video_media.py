"""Bounded, self-contained video import and CPU-only trim/resize/FPS conversion."""
from contextlib import contextmanager
from fractions import Fraction
import math

from .media import _binary_source, decode_audio, SAMPLE_RATE
from .project import ValidationError

_VIDEO_DEMUXERS = "avi,matroska,webm,mov,mp4,m4a,3gp,3g2,mj2,mpeg,mpegts"


def _deny_io(*_args):
    raise ValidationError("Video must be a self-contained file without external resources.")


@contextmanager
def open_video(source):
    import av
    with _binary_source(source) as raw:
        with av.open(raw, mode="r", io_open=_deny_io, options={
                "format_whitelist": _VIDEO_DEMUXERS, "protocol_whitelist": "",
                "enable_drefs": "0", "use_absolute_path": "0"}) as container:
            if not container.streams.video:
                raise ValidationError("The file has no video stream.")
            yield container


def inspect_video(source):
    with open_video(source) as container:
        stream = container.streams.video[0]
        rate = stream.average_rate or stream.guessed_rate
        if rate is None or not 1 <= float(rate) <= 120:
            raise ValidationError("Video frame rate must be between 1 and 120 FPS.")
        width, height = stream.width, stream.height
        if not 1 <= width <= 8192 or not 1 <= height <= 8192 or width * height > 33554432:
            raise ValidationError("Video resolution exceeds the supported size.")
        count, origin = 0, None
        for frame in container.decode(video=0):
            if frame.width != width or frame.height != height:
                raise ValidationError("Video resolution cannot change within a clip.")
            if frame.pts is not None:
                timestamp = frame.pts * frame.time_base
                if origin is None:
                    origin = timestamp
                # Frame-based edits require a constant-rate source. Normalizing
                # container timebase rounding is safe; changing VFR timing is not.
                if abs(float((timestamp - origin) * rate) - count) > 0.51:
                    raise ValidationError("Use a constant-frame-rate video before importing.")
            count += 1
            if count > 72000 or count / float(rate) > 600.001:
                raise ValidationError("Imported video cannot exceed 10 minutes.")
        if not count:
            raise ValidationError("The video has no frames.")
        return {"frameCount": count, "fps": float(rate), "width": width, "height": height,
                "hasAudio": bool(container.streams.audio)}


def audio_window(source, *, start, seconds, samples):
    import numpy as np
    with open_video(source) as container:
        if not container.streams.audio:
            return np.zeros((2, samples), dtype=np.float32)
        video, audio = container.streams.video[0], container.streams.audio[0]
        video_origin = float((video.start_time or 0) * video.time_base)
        audio_origin = float((audio.start_time or 0) * audio.time_base)
    # The conditioning decoder limits one prepared window to 68 seconds.
    # Existing footage can be longer, so read exact bounded sample windows.
    offset = start + video_origin - audio_origin
    window = SAMPLE_RATE * 60
    pieces = [decode_audio(source, start_seconds=offset + first / SAMPLE_RATE,
                           duration_seconds=min(window, samples - first) / SAMPLE_RATE)
              for first in range(0, samples, window)]
    return np.concatenate(pieces, axis=1) if pieces else np.zeros((2, 0), dtype=np.float32)


def transcode_video(source, destination, *, metadata=None, start_frame=0,
                    frames=None, fps=None, width=None, height=None, samples=None):
    """Encode a safe constant-rate MP4, returning exact PCM for concatenation."""
    import av
    import numpy as np
    from av.video.reformatter import ColorPrimaries, ColorRange, ColorTrc, Colorspace
    metadata = metadata or inspect_video(source)
    fps = Fraction(str(fps or metadata["fps"])).limit_denominator(100000)
    source_fps = Fraction(str(metadata["fps"])).limit_denominator(100000)
    width, height = width or metadata["width"], height or metadata["height"]
    # YUV420 requires even dimensions. Imported odd frames gain one black pixel.
    width += width % 2
    height += height % 2
    frames = frames or metadata["frameCount"]
    seconds = frames / float(fps)
    if start_frame < 0 or start_frame + seconds * float(source_fps) > metadata["frameCount"] + 1e-6:
        raise ValidationError("Video selection exceeds its source frames.")
    samples = round(frames * SAMPLE_RATE / fps) if samples is None else samples
    pcm = audio_window(source, start=start_frame / float(source_fps), seconds=seconds, samples=samples)
    with av.open(destination, mode="w", format="mp4") as output:
        stream = output.add_stream("libx264", rate=fps)
        stream.width, stream.height, stream.pix_fmt = width, height, "yuv420p"
        stream.options = {"preset": "ultrafast", "crf": "18"}
        stream.codec_context.max_b_frames = 0
        # Match the SDR encoding of ComfyUI's generated takes when assembling a mixed timeline.
        stream.codec_context.color_primaries = ColorPrimaries.BT709
        stream.codec_context.color_trc = ColorTrc.IEC61966_2_1
        stream.codec_context.colorspace = Colorspace.ITU709
        stream.codec_context.color_range = ColorRange.MPEG
        audio_stream = None
        if metadata["hasAudio"]:
            audio_stream = output.add_stream("aac", rate=SAMPLE_RATE)
            audio_stream.layout = "stereo"
            audio_stream.bit_rate = 192000
        emitted = 0
        with open_video(source) as container:
            for source_index, frame in enumerate(container.decode(video=0)):
                required = start_frame + math.floor(emitted * source_fps / fps)
                if source_index < required:
                    continue
                ratio = min(width / frame.width, height / frame.height)
                scaled_w, scaled_h = max(1, round(frame.width * ratio)), max(1, round(frame.height * ratio))
                pixels = frame.reformat(width=scaled_w, height=scaled_h, format="rgb24").to_ndarray()
                canvas = np.zeros((height, width, 3), dtype=np.uint8)
                x, y = (width - scaled_w) // 2, (height - scaled_h) // 2
                canvas[y:y + scaled_h, x:x + scaled_w] = pixels
                while emitted < frames and start_frame + math.floor(emitted * source_fps / fps) == source_index:
                    encoded = av.VideoFrame.from_ndarray(canvas, format="rgb24").reformat(
                        format=stream.pix_fmt, dst_colorspace=Colorspace.ITU709)
                    encoded.pts, encoded.time_base = emitted, 1 / fps
                    for packet in stream.encode(encoded):
                        output.mux(packet)
                    emitted += 1
                if emitted == frames:
                    break
        if emitted != frames:
            raise ValidationError("Video ended before its selected frames.")
        for packet in stream.encode(None):
            output.mux(packet)
        if audio_stream:
            for offset in range(0, samples, 8192):
                frame = av.AudioFrame.from_ndarray(pcm[:, offset:offset + 8192].copy(), format="fltp", layout="stereo")
                frame.sample_rate, frame.pts, frame.time_base = SAMPLE_RATE, offset, Fraction(1, SAMPLE_RATE)
                for packet in audio_stream.encode(frame):
                    output.mux(packet)
            for packet in audio_stream.encode(None):
                output.mux(packet)
    return {"frameCount": frames, "fps": float(fps), "width": width, "height": height,
            "hasAudio": metadata["hasAudio"]}, pcm
