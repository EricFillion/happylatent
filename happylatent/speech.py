"""Optional Kokoro bridge. ComfyUI never imports the separate speech runtime."""
from __future__ import annotations

import hashlib
import json
import math
import os
from pathlib import Path
import re
import subprocess
import tempfile
import time
import wave

SPEAKER_ID = re.compile(r"[abefhip][fm]_[a-z0-9_]{1,29}")
DEFAULT_VOICES = ["af_heart", "am_michael", "bf_emma", "bm_fable"]
WORKER = Path(__file__).with_name("speech_worker.py")
WORKER_TIMEOUT = 300
SETUP_HELP = "Enable optional Kokoro speech using the Speech setup instructions in the Happy Latent README."


def _state_dir():
    return Path(os.environ.get("HAPPYLATENT_STATE_DIR", str(Path.home() / ".happylatent-agent"))).expanduser().resolve()


def _settings():
    try:
        config = json.loads((_state_dir() / "config.json").read_text(encoding="utf-8"))
    except FileNotFoundError:
        raise ValueError("Optional Kokoro speech is not configured. " + SETUP_HELP) from None
    except (OSError, ValueError):
        raise ValueError("The optional speech configuration could not be read. " + SETUP_HELP) from None
    speech = config.get("speech") if isinstance(config, dict) else None
    if not isinstance(speech, dict) or not (speech.get("modelDir") or speech.get("python")):
        raise ValueError("Optional Kokoro speech is not configured. " + SETUP_HELP)
    python = speech.get("python", "python3")
    model_dir = speech.get("modelDir")
    device = speech.get("device", "cpu")
    if (not isinstance(python, str) or not python.strip() or "\x00" in python
            or (model_dir is not None and (not isinstance(model_dir, str) or not model_dir.strip() or "\x00" in model_dir))
            or device not in ("auto", "cpu", "cuda", "mps")):
        raise ValueError("The optional speech configuration is invalid. " + SETUP_HELP)
    return {"python": python, "model_dir": Path(model_dir).expanduser().resolve() if model_dir else None, "device": device}


def _model_roots(settings):
    roots = []
    if settings and settings["model_dir"]:
        roots.append(("configured", settings["model_dir"]))
    try:
        import folder_paths
    except ModuleNotFoundError as error:
        if error.name != "folder_paths":
            raise
        return roots
    try:
        paths = list(folder_paths.get_folder_paths("kokoro"))
    except (KeyError, AttributeError):
        paths = []
    if getattr(folder_paths, "models_dir", None):
        paths.append(str(Path(folder_paths.models_dir) / "kokoro"))
    seen = {path.resolve() for _, path in roots}
    index = 0
    for path in paths:
        root = Path(path).expanduser().resolve()
        if root in seen:
            continue
        seen.add(root)
        index += 1
        roots.append(("models" if index == 1 else f"models-{index}", root))
    return roots


def _catalog(settings=None):
    """Only locally discovered files can become workflow selections."""
    result = {"checkpoint": {}, "model_config": {}, "speaker": {}}
    voice_paths = set()
    for label, root in _model_roots(settings):
        if not root.is_dir():
            continue
        # Preserve the legacy modelDir/voices/<id>.pt mapping even when a
        # nested model pack sorts earlier than the root voices directory.
        for path in sorted(root.rglob("*"), key=lambda path: (path.parent != root / "voices", path.as_posix())):
            if not path.is_file() or path.stat().st_size == 0:
                continue
            relative = path.relative_to(root)
            identifier = f"{label}/{relative.as_posix()}"
            if path.suffix == ".pth" and "voices" not in relative.parts:
                result["checkpoint"][identifier] = path
            elif path.suffix == ".json" and "voices" not in relative.parts:
                result["model_config"][identifier] = path
            elif path.suffix == ".pt" and "voices" in relative.parts and SPEAKER_ID.fullmatch(path.stem):
                actual = path.resolve()
                if actual in voice_paths:
                    continue
                voice_paths.add(actual)
                # Existing workflows retain plain preset IDs. Conflicting presets
                # remain separately selectable using their source-relative name.
                key = path.stem if path.stem not in result["speaker"] else identifier
                result["speaker"][key] = path
    return result


def _available_catalog():
    try:
        settings = _settings()
    except (ValueError, OSError):
        settings = None
    try:
        return _catalog(settings)
    except OSError:
        return {"checkpoint": {}, "model_config": {}, "speaker": {}}


def _select_components(settings, speaker, checkpoint=None, model_config=None):
    catalog = _catalog(settings)
    selected = {}
    for field, value, old_name in (("checkpoint", checkpoint, "kokoro-v1_0.pth"),
                                   ("model_config", model_config, "config.json")):
        if value is None:
            value = f"configured/{old_name}" if settings["model_dir"] else next(iter(catalog[field]), None)
        if not isinstance(value, str) or value not in catalog[field]:
            raise ValueError(f"Selected Kokoro {field.replace('_', ' ')} is unavailable. Choose an installed file on the speech node. " + SETUP_HELP)
        selected[field] = catalog[field][value]
    if not isinstance(speaker, str) or speaker not in catalog["speaker"]:
        raise ValueError("Selected Kokoro voice is not installed. Choose an installed voice on the speech node. " + SETUP_HELP)
    selected["voice"] = catalog["speaker"][speaker]
    selected["speaker_id"] = selected["voice"].stem
    return selected


def speech_setup_status():
    """Cheap UI status only: configured files do not prove runtime readiness."""
    base = {"model": "Kokoro 82M v1.0", "speakers": []}
    try:
        settings = _settings()
        catalog = _catalog(settings)
        if any(not values for values in catalog.values()):
            return {**base, "status": "unavailable", "reason": "Kokoro checkpoint, model config or voice files are missing. " + SETUP_HELP}
        return {**base, "status": "configured", "speakers": list(catalog["speaker"])}
    except ValueError as error:
        return {**base, "status": "unconfigured", "reason": str(error)}
    except OSError:
        return {**base, "status": "unavailable", "reason": "Kokoro files could not be read. " + SETUP_HELP}


def _validate_request(text, speaker, speed):
    if not isinstance(text, str) or not 1 <= len(text.strip()) <= 1000:
        raise ValueError("Speech text must contain between 1 and 1,000 characters.")
    if not isinstance(speaker, str) or not speaker.strip():
        raise ValueError("Choose an installed Kokoro voice, such as af_heart.")
    if type(speed) not in (int, float) or not math.isfinite(speed) or not 0.5 <= speed <= 2:
        raise ValueError("Speech speed must be between 0.5 and 2.")


def _check_interrupted():
    try:
        from comfy.model_management import throw_exception_if_processing_interrupted
    except ModuleNotFoundError as error:
        if error.name not in ("comfy", "comfy.model_management"):
            raise
        return
    throw_exception_if_processing_interrupted()


def _run_worker(settings, request, output, log, components=None):
    lock_dir = _state_dir() / "speech-jobs"
    lock_dir.mkdir(parents=True, exist_ok=True)
    command = [settings["python"], str(WORKER), "generate",
               "--device", settings["device"], "--request", str(request), "--output", str(output),
               "--lock", str(lock_dir / "worker.lock")]
    if components is None:
        command += ["--model-dir", str(settings["model_dir"])]
    else:
        command += ["--checkpoint", str(components["checkpoint"]), "--config", str(components["model_config"]),
                    "--voice", str(components["voice"])]
    try:
        with log.open("wb") as errors:
            process = subprocess.Popen(command, stdin=subprocess.DEVNULL, stdout=subprocess.DEVNULL, stderr=errors)
            deadline = time.monotonic() + WORKER_TIMEOUT
            try:
                while True:
                    _check_interrupted()
                    if time.monotonic() >= deadline:
                        raise RuntimeError("Kokoro speech generation timed out. Check the optional speech runtime and device.")
                    try:
                        returncode = process.wait(timeout=0.25)
                        break
                    except subprocess.TimeoutExpired:
                        continue
            finally:
                if process.poll() is None:
                    process.kill()
                process.wait()
    except OSError:
        raise RuntimeError("Could not start the optional Kokoro worker. " + SETUP_HELP) from None
    if returncode:
        # Worker errors explain missing models/dependencies without exposing the script.
        with log.open("rb") as errors:
            errors.seek(0, 2)
            errors.seek(max(0, errors.tell() - 2048))
            lines = errors.read().decode("utf-8", errors="replace").strip().splitlines()
        reason = lines[-1] if lines else "The separate speech worker failed."
        raise RuntimeError(f"Kokoro speech generation failed: {reason} {SETUP_HELP}")


def _read_audio(path):
    import numpy as np
    import torch

    try:
        with wave.open(str(path), "rb") as source:
            if (source.getnchannels(), source.getsampwidth(), source.getframerate(), source.getcomptype()) != (1, 2, 24000, "NONE"):
                raise ValueError("Kokoro must produce a mono 24 kHz PCM16 WAV.")
            count = source.getnframes()
            pcm = source.readframes(count)
            if count <= 0 or len(pcm) != count * 2:
                raise ValueError("Kokoro returned an empty or incomplete WAV.")
    except (OSError, EOFError, wave.Error) as error:
        raise ValueError("Kokoro did not produce a readable WAV.") from error
    samples = np.frombuffer(pcm, dtype="<i2").astype(np.float32) / 32768.0
    if not np.any(samples):
        raise ValueError("Kokoro returned silent audio.")
    return {"waveform": torch.from_numpy(samples).reshape(1, 1, -1), "sample_rate": 24000}


def _resolve_model(settings, model):
    catalog = _catalog(settings)
    if not isinstance(model, str) or model not in catalog["checkpoint"]:
        raise ValueError("Selected Kokoro model is unavailable. Choose an installed model in Kokoro Model Loader.")
    checkpoint = catalog["checkpoint"][model]
    config = checkpoint.parent / "config.json"
    if not config.is_file() or config.stat().st_size == 0:
        raise ValueError("Kokoro requires config.json beside the selected model file.")
    return checkpoint, config


class HappyLatentKokoroModelLoader:
    @classmethod
    def INPUT_TYPES(cls):
        models = list(_available_catalog()["checkpoint"]) or ["(no local model)"]
        return {"required": {"model": (models, {"default": "configured/kokoro-v1_0.pth" if "configured/kokoro-v1_0.pth" in models else models[0]})}}

    RETURN_TYPES = ("KOKORO_MODEL",)
    RETURN_NAMES = ("model",)
    FUNCTION = "load_model"
    CATEGORY = "Happy Latent/internal"
    # Keep legacy graph execution; new usage is through MCP.
    DEPRECATED = True
    DESCRIPTION = "Select a local Kokoro model. Finds config.json beside it; weights are loaded in the optional isolated speech worker during synthesis."

    def load_model(self, model):
        _resolve_model(_settings(), model)
        return ({"model": model},)

    @classmethod
    def IS_CHANGED(cls, model):
        try:
            paths = _resolve_model(_settings(), model)
            return tuple((str(p), p.stat().st_size, p.stat().st_mtime_ns) for p in paths)
        except (ValueError, OSError):
            return float("nan")


def _components_from_model(settings, speaker, model):
    if not isinstance(model, dict) or set(model) != {"model"}:
        raise ValueError("Connect Kokoro Model Loader to the speech model input.")
    checkpoint, config = _resolve_model(settings, model["model"])
    catalog = _catalog(settings)
    if speaker not in catalog["speaker"]:
        raise ValueError("Selected Kokoro voice is not installed.")
    voice = catalog["speaker"][speaker]
    return {"checkpoint": checkpoint, "model_config": config, "voice": voice, "speaker_id": voice.stem}


class HappyLatentSpeech:
    @classmethod
    def INPUT_TYPES(cls):
        catalog = _available_catalog()
        speakers = list(catalog["speaker"]) or DEFAULT_VOICES
        return {"required": {
            "model": ("KOKORO_MODEL",),
            "text": ("STRING", {"default": "Hello! I hope you enjoy using Happy Latent", "multiline": True}),
            "speaker": (speakers, {"default": "af_heart" if "af_heart" in speakers else speakers[0]}),
            "speed": ("FLOAT", {"default": 1.0, "min": 0.5, "max": 2.0, "step": 0.05}),
        }}

    RETURN_TYPES = ("AUDIO",)
    RETURN_NAMES = ("audio",)
    FUNCTION = "generate"
    CATEGORY = "Happy Latent/internal"
    # Keep legacy graph execution; new usage is through MCP.
    DEPRECATED = True
    DESCRIPTION = "Generate speech with optional local Kokoro. Requires a separately configured speech environment; no packages are installed in ComfyUI."

    @classmethod
    def IS_CHANGED(cls, text, speaker, speed, checkpoint=None, model_config=None, model=None):
        # Native inputs cover the request. Include external model/config state so
        # repairing or changing optional setup invalidates ComfyUI's audio cache.
        paths = [_state_dir() / "config.json", WORKER]
        try:
            settings = _settings()
            selected = (_components_from_model(settings, speaker, model) if model is not None
                        else _select_components(settings, speaker, checkpoint, model_config))
            paths += [selected[key] for key in ("checkpoint", "model_config", "voice")]
        except (ValueError, OSError):
            pass
        fingerprint = []
        for path in paths:
            try:
                stat = path.stat()
                fingerprint.append((str(path), stat.st_size, stat.st_mtime_ns))
            except OSError:
                fingerprint.append((str(path), None))
        return hashlib.sha256(json.dumps(fingerprint).encode()).hexdigest()

    def generate(self, text, speaker, speed=1.0, checkpoint=None, model_config=None, model=None):
        _validate_request(text, speaker, speed)
        settings = _settings()
        selected = (_components_from_model(settings, speaker, model) if model is not None
                        else _select_components(settings, speaker, checkpoint, model_config))
        with tempfile.TemporaryDirectory(prefix="happylatent-speech-") as directory:
            root = Path(directory)
            request = root / "request.json"
            request.write_text(json.dumps({"text": text.strip(), "speaker": selected["speaker_id"], "speed": speed}), encoding="utf-8")
            output = root / "speech.wav"
            _run_worker(settings, request, output, root / "worker.log", selected)
            return (_read_audio(output),)
