"""Generate speech from an installed Kokoro 82M v1.0 checkpoint and presets."""

import argparse
from contextlib import contextmanager, redirect_stdout
import json
import os
from pathlib import Path
import re
import sys
import tempfile
import time
import wave

# Apply before importing Transformers or huggingface_hub.
for variable in ("HF_HUB_OFFLINE", "TRANSFORMERS_OFFLINE", "HF_DATASETS_OFFLINE", "HF_HUB_DISABLE_TELEMETRY"):
    os.environ[variable] = "1"
os.environ.setdefault("PYTORCH_ENABLE_MPS_FALLBACK", "1")

REPO_ID = "hexgrad/Kokoro-82M"
WEIGHTS = "kokoro-v1_0.pth"
SAMPLE_RATE = 24000
# English plus the stock v1.0 eSpeak languages. The Japanese and Mandarin
# pipelines have additional pronunciation data dependencies.
SPEAKER_ID = re.compile(r"[abefhip][fm]_[a-z0-9_]{1,29}")


def status(name, speakers=(), **fields):
    return {"status": name, "speakers": list(speakers), **fields}


def has_file(path):
    return path.is_file() and path.stat().st_size > 0


def discover_models(directory):
    missing = [name for name in ("config.json", WEIGHTS) if not has_file(directory / name)]
    voices = directory / "voices"
    speakers = sorted(file.stem for file in voices.glob("*.pt") if SPEAKER_ID.fullmatch(file.stem) and has_file(file))
    if not speakers:
        missing.append("voices/*.pt")
    if missing:
        return status(
            "missing_models",
            missing=missing,
            reason="Select a local Kokoro 82M v1.0 directory with config.json, kokoro-v1_0.pth, and at least one supported preset in voices/.",
        ), None
    return load_config(directory / "config.json", speakers)


def load_config(path, speakers):
    try:
        config = json.loads(path.read_text(encoding="utf-8"))
    except (ValueError, OSError):
        return status("unavailable", reason="The selected Kokoro model config could not be read."), None
    if not isinstance(config, dict) or config.get("multispeaker") is not True or config.get("n_token") != 178:
        return status("unavailable", reason="The selected model config does not match Kokoro 82M v1.0."), None
    return status("ready", speakers), config


def discover_components(checkpoint, config_path, voice_path):
    if any(path is None or not has_file(path) for path in (checkpoint, config_path, voice_path)):
        return status("missing_models", reason="Select an installed Kokoro checkpoint, model config, and voice preset."), None
    if not SPEAKER_ID.fullmatch(voice_path.stem):
        return status("unavailable", reason="The selected file is not a supported Kokoro voice preset."), None
    return load_config(config_path, [voice_path.stem])


def resolve_device(torch, requested):
    if requested == "auto":
        return "cpu"
    if requested == "cuda" and not torch.cuda.is_available():
        raise ValueError("CUDA is unavailable in the selected Python environment. Set the speech device to cpu or use a CUDA PyTorch build.")
    if requested == "mps" and not torch.backends.mps.is_available():
        raise ValueError("Apple MPS is unavailable in the selected Python environment. Set the speech device to cpu or use an MPS PyTorch build.")
    return requested


def require_local_files(*args, **kwargs):
    raise RuntimeError("Speech synthesis requires installed local model and pronunciation files.")


def check_setup(model_dir, requested_device, checkpoint=None, config_path=None, voice_path=None):
    try:
        if any(path is not None for path in (checkpoint, config_path, voice_path)):
            setup, config = discover_components(checkpoint, config_path, voice_path)
        elif model_dir is not None:
            setup, config = discover_models(model_dir)
        else:
            return status("missing_models", reason="Select a model directory or explicit Kokoro model components."), None
    except OSError:
        return status("unavailable", reason="The configured Kokoro model files could not be accessed."), None
    if setup["status"] != "ready":
        return setup, None

    try:
        with redirect_stdout(sys.stderr):
            import huggingface_hub
            import numpy
            import spacy
            import torch

            huggingface_hub.hf_hub_download = require_local_files
            spacy.cli.download = require_local_files
            from kokoro import KModel, KPipeline
    except Exception as error:
        return status(
            "missing_dependencies",
            reason=f"Could not import the Kokoro runtime ({type(error).__name__}). Check Kokoro, Misaki, and PyTorch in the configured Python environment.",
        ), None

    speakers = setup["speakers"]
    if not spacy.util.is_package("en_core_web_sm"):
        speakers = [speaker for speaker in speakers if speaker[0] not in "ab"]
        if not speakers:
            return status(
                "missing_dependencies",
                missing=["en_core_web_sm"],
                reason="The installed English voices require the local spaCy en_core_web_sm pronunciation model.",
            ), None
    try:
        device = resolve_device(torch, requested_device)
    except ValueError as error:
        return status("unavailable", reason=str(error)), None
    return status("ready", speakers, device=device), (config, numpy, torch, KModel, KPipeline)


def read_request(path):
    try:
        request = json.loads(path.read_text(encoding="utf-8"))
    except (ValueError, OSError) as error:
        raise ValueError("The speech request file could not be read.") from error
    if not isinstance(request, dict):
        raise ValueError("Speech requests require text and a Kokoro speaker ID.")
    text = request.get("text")
    speaker = request.get("speaker")
    speed = request.get("speed", 1)
    if not isinstance(text, str) or not 1 <= len(text.strip()) <= 1000:
        raise ValueError("Speech text must contain between 1 and 1,000 characters.")
    if not isinstance(speaker, str) or not SPEAKER_ID.fullmatch(speaker):
        raise ValueError("Choose a supported local Kokoro speaker ID, such as af_heart.")
    if type(speed) not in (int, float) or not 0.5 <= speed <= 2:
        raise ValueError("Speech speed must be between 0.5 and 2.")
    return text.strip(), speaker, speed


@contextmanager
def generation_lock(path):
    if path is None:
        yield
        return
    descriptor = os.open(path, os.O_CREAT | os.O_RDWR | getattr(os, "O_NOFOLLOW", 0), 0o600)
    try:
        if os.name == "nt":
            import msvcrt
            # Windows byte-range locking needs one byte in the shared lock file.
            if os.fstat(descriptor).st_size == 0:
                os.write(descriptor, b"\0")
            while True:
                os.lseek(descriptor, 0, os.SEEK_SET)
                try:
                    msvcrt.locking(descriptor, msvcrt.LK_NBLCK, 1)
                    break
                except OSError:
                    time.sleep(0.1)
        else:
            import fcntl
            fcntl.flock(descriptor, fcntl.LOCK_EX)
        yield
    finally:
        os.close(descriptor)


def generate(args, setup, runtime):
    config, numpy, torch, model_class, pipeline_class = runtime
    text, speaker, speed = read_request(args.request)
    if speaker not in setup["speakers"]:
        raise ValueError(f"The Kokoro preset {speaker} is unavailable. Run the speech setup check for usable voices.")
    device = setup["device"]
    with redirect_stdout(sys.stderr):
        if device == "cpu":
            torch.set_num_threads(min(torch.get_num_threads(), 4))
        try:
            model = model_class(
                repo_id=REPO_ID, config=config, model=str(getattr(args, "checkpoint", None) or args.model_dir / WEIGHTS),
                disable_complex=device == "mps",
            ).to(device).eval()
            voice = torch.load(getattr(args, "voice", None) or args.model_dir / "voices" / f"{speaker}.pt", map_location="cpu", weights_only=True)
            if not isinstance(voice, torch.Tensor) or tuple(voice.shape) != (510, 1, 256):
                raise ValueError("Unexpected Kokoro preset shape")
            pipeline = pipeline_class(lang_code=speaker[0], repo_id=REPO_ID, model=model, device=device)
            with torch.inference_mode():
                clips = [
                    piece.audio.detach().cpu().numpy()
                    for piece in pipeline(text, voice=voice, speed=speed)
                    if piece.audio is not None
                ]
        except Exception as error:
            raise RuntimeError(
                f"Kokoro could not synthesize speech on {device} ({type(error).__name__}). Check the local voice preset and device."
            ) from error

    if not clips or any(clip.ndim != 1 or not clip.size for clip in clips):
        raise RuntimeError("Kokoro did not return a valid mono waveform.")
    samples = numpy.concatenate(clips)
    if not numpy.isfinite(samples).all() or not numpy.any(samples):
        raise RuntimeError("Kokoro returned an invalid or silent waveform.")

    pcm = numpy.rint(samples * 32768.0).clip(-32768, 32767).astype("<i2")
    descriptor, temporary = tempfile.mkstemp(prefix=f".{args.output.name}.", suffix=".wav", dir=args.output.parent)
    try:
        with os.fdopen(descriptor, "wb") as output, wave.open(output, "wb") as wav:
            wav.setnchannels(1)
            wav.setsampwidth(2)
            wav.setframerate(SAMPLE_RATE)
            wav.writeframes(pcm.tobytes())
        os.replace(temporary, args.output)
    finally:
        Path(temporary).unlink(missing_ok=True)


def run(args):
    if args.model_dir is not None:
        args.model_dir = args.model_dir.resolve()
    if args.command == "check":
        setup, _ = check_setup(args.model_dir, args.device)
        print(json.dumps(setup))
        return 0
    try:
        with generation_lock(args.lock):
            setup, runtime = check_setup(args.model_dir, args.device, args.checkpoint, args.config, args.voice)
            if setup["status"] != "ready":
                print(setup["reason"], file=sys.stderr)
                return 1
            generate(args, setup, runtime)
    except (ValueError, RuntimeError) as error:
        print(error, file=sys.stderr)
        return 1
    except OSError:
        print("Could not lock or save the local speech result.", file=sys.stderr)
        return 1
    return 0


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    commands = parser.add_subparsers(dest="command", required=True)
    for command in ("check", "generate"):
        subparser = commands.add_parser(command)
        subparser.add_argument("--model-dir", type=Path, required=command == "check")
        subparser.add_argument("--device", choices=("auto", "cpu", "cuda", "mps"), default="auto")
        if command == "generate":
            subparser.add_argument("--request", type=Path, required=True)
            subparser.add_argument("--output", type=Path, required=True)
            subparser.add_argument("--lock", type=Path)
            subparser.add_argument("--checkpoint", type=Path)
            subparser.add_argument("--config", type=Path)
            subparser.add_argument("--voice", type=Path)
    return run(parser.parse_args())


if __name__ == "__main__":
    sys.exit(main())
