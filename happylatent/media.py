"""Decode and normalize uploaded audio using ComfyUI's PyAV."""
from __future__ import annotations

from contextlib import contextmanager, nullcontext
from pathlib import Path
import wave

from .project import ValidationError

SAMPLE_RATE = 48000
MAX_SOURCE_SECONDS = 600
# Uploaded source windows allow ten minutes plus up to eight padding frames.
MAX_PREPARED_SECONDS = MAX_SOURCE_SECONDS + 8
# Only ordinary media containers, never manifests/playlists or device inputs.
# FFmpeg checks this allowlist after probing bytes and BEFORE read_header(),
# where HLS/concat/DASH could already open another file. Filename checks are
# insufficient: uploads have a temporary suffix and content determines format.
_AUDIO_DEMUXERS = ",".join((
    "aac", "ac3", "aiff", "amr", "asf", "au", "avi", "caf", "dts", "eac3",
    "flac", "matroska", "webm", "mov", "mp4", "m4a", "3gp", "3g2", "mj2",
    "mp3", "mpeg", "mpegts", "ogg", "w64", "wav",
))


def _binary_source(source):
    # Runtime callers supply a securely opened handle. Path support is retained
    # for local conversion utilities; no decoder ever reopens a supplied handle.
    if hasattr(source, "read"):
        source.seek(0)
        return nullcontext(source)
    return open(source, "rb")


def _deny_secondary_audio_io(_url, _flags, _options):
    # Do not include the requested URL: it can contain private paths or secrets.
    raise ValidationError("Audio must be a self-contained file without external resources.")


@contextmanager
def _open_audio_source(path):
    import av

    # Give FFmpeg only the file Python opened, rather than a filename/URL it can
    # interpret as a protocol. Deny every secondary open, including local files,
    # segments and encryption keys. The empty protocol allowlist also blocks
    # native protocol opens if a demuxer bypasses the custom I/O callback.
    with _binary_source(path) as raw:
        if raw.read(4) == b"RIFX":
            # The bundled FFmpeg misreads RIFX PCM as little-endian samples.
            raise ValidationError("Big-endian RIFX audio is unsupported; convert it to standard WAV.")
        raw.seek(0)
        with av.open(raw, mode="r", io_open=_deny_secondary_audio_io, options={
            "format_whitelist": _AUDIO_DEMUXERS,
            "protocol_whitelist": "",
            # MOV supports external data references; keep them disabled even
            # when future FFmpeg versions change the current safe defaults.
            "enable_drefs": "0", "use_absolute_path": "0",
        }) as source:
            yield source


def _read_pcm_window(path, start, length):
    """Seek normalized WAV samples directly; other formats need PyAV's filters."""
    import numpy as np

    try:
        with _binary_source(path) as raw:
            # Python's wave reader also accepts WAVE_FORMAT_EXTENSIBLE but
            # discards its channel mask. Two channels might be center + LFE,
            # requiring a remix rather than treating them as left and right.
            # Our normalized files use the canonical 16-byte PCM fmt header.
            header = raw.read(36)
            if (header[:4] != b"RIFF" or header[8:20] != b"WAVEfmt \x10\x00\x00\x00"
                    or header[20:22] != b"\x01\x00"):
                return None
            raw.seek(0)
            with wave.open(raw, "rb") as source:
                if (source.getframerate(), source.getnchannels(), source.getsampwidth(),
                        source.getcomptype()) != (SAMPLE_RATE, 2, 2, "NONE"):
                    return None
                if not length or start >= source.getnframes():
                    return np.zeros((2, 0), dtype=np.float32)
                source.setpos(start)
                data = source.readframes(length)
    except (wave.Error, EOFError):
        return None
    # A partial PCM frame is malformed; let PyAV produce its normal decode error.
    if len(data) % 4:
        return None
    return np.frombuffer(data, dtype="<i2").reshape(-1, 2).T.astype(np.float32) / 32768


def _pad_window(data, start, length):
    import numpy as np

    output = np.zeros((2, length), dtype=np.float32)
    destination = min(length, max(0, -start))
    count = min(data.shape[1], length - destination)
    if count:
        output[:, destination:destination + count] = data[:, :count]
    return output


def decode_audio(path, *, start_seconds=0.0, duration_seconds=None):
    """Decode stereo float samples; negative start and EOF become silence."""
    import av
    import numpy as np

    if duration_seconds is not None and not 0 <= duration_seconds <= MAX_PREPARED_SECONDS:
        raise ValidationError(f"Prepared audio duration must be between zero and {MAX_PREPARED_SECONDS} seconds.")
    start_sample = round(start_seconds * SAMPLE_RATE)
    length = None if duration_seconds is None else round(duration_seconds * SAMPLE_RATE)
    pieces, cursor = [], 0
    wanted_start = max(0, start_sample)
    wanted_end = SAMPLE_RATE * MAX_SOURCE_SECONDS if length is None else max(0, start_sample + length)
    if length is not None:
        # Uploaded audio is already stereo 48 kHz PCM. Reading each late scene
        # from the beginning costs O(source position), repeated across scenes.
        # Exact PCM seeking avoids that work without resetting a resampler or
        # compressed codec's history. Unbounded uploads still enforce the cap.
        data = _read_pcm_window(path, wanted_start, max(0, wanted_end - wanted_start))
        if data is not None:
            return _pad_window(data, start_sample, length)
    with _open_audio_source(path) as source:
        if not source.streams.audio:
            raise ValidationError("The file has no audio stream.")
        resampler = av.AudioResampler(format="fltp", layout="stereo", rate=SAMPLE_RATE)
        for decoded in source.decode(audio=0):
            for frame in resampler.resample(decoded):
                data = frame.to_ndarray()
                end = cursor + data.shape[1]
                left, right = max(cursor, wanted_start), min(end, wanted_end)
                if right > left:
                    pieces.append(data[:, left - cursor:right - cursor].copy())
                cursor = end
            if length is None and cursor > SAMPLE_RATE * MAX_SOURCE_SECONDS:
                raise ValidationError("Audio cannot exceed 10 minutes.")
            if length is not None and cursor >= wanted_end:
                break
        else:
            for frame in resampler.resample(None):
                data = frame.to_ndarray()
                end = cursor + data.shape[1]
                left, right = max(cursor, wanted_start), min(end, wanted_end)
                if right > left:
                    pieces.append(data[:, left - cursor:right - cursor].copy())
                cursor = end
    data = np.concatenate(pieces, axis=1) if pieces else np.zeros((2, 0), dtype=np.float32)
    if length is None:
        if cursor > SAMPLE_RATE * MAX_SOURCE_SECONDS:
            raise ValidationError("Audio cannot exceed 10 minutes.")
        return data
    return _pad_window(data, start_sample, length)


def write_wav(path, samples):
    import numpy as np

    samples = np.asarray(samples, dtype=np.float32)
    if samples.ndim != 2 or samples.shape[0] != 2:
        raise ValidationError("Audio must contain two channels of samples.")
    if not np.isfinite(samples).all():
        raise ValidationError("Audio contains non-finite samples.")
    if not hasattr(path, "write"):
        Path(path).parent.mkdir(parents=True, exist_ok=True)
    # Half precision rounds 32767 up to 32768, which wraps positive full scale
    # to negative int16. Normalize the arithmetic before quantizing.
    pcm = (np.clip(samples, -1.0, 1.0) * 32767).astype("<i2").T.copy()
    with wave.open(path if hasattr(path, "write") else str(path), "wb") as output:
        output.setnchannels(2)
        output.setsampwidth(2)
        output.setframerate(SAMPLE_RATE)
        output.writeframes(pcm.tobytes())
