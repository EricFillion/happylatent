from pathlib import Path

from huggingface_hub import hf_hub_download

REPO_ID = "Lightricks/LTX-2.5"
COMFYUI_DIR = Path('/workspace/runpod-slim/ComfyUI')
MODELS = (
    "diffusion_models/ltx-2.5-22b-distilled-transformer-comfy-int8-convrot.safetensors",
    "text_encoders/gemma4-12b-with-proj-ltx-2.5-comfy-int8-convrot.safetensors",
    "vae/ltx-2.5-video-vae-bf16.safetensors",
    "vae/ltx-2.5-audio-vae-bf16.safetensors",
)


def download_models(models_dir: Path) -> None:
    print(f"Model destination: {models_dir}", flush=True)
    for index, filename in enumerate(MODELS, start=1):
        target = models_dir / filename
        print(f"[{index}/{len(MODELS)}] {filename}", flush=True)
        hf_hub_download(repo_id=REPO_ID, filename=filename, local_dir=str(models_dir))
        if not target.is_file() or target.stat().st_size == 0:
            raise RuntimeError(f"Download missing or empty: {target}")
    print(f"All {len(MODELS)} models are ready. Refresh ComfyUI's model list.")


def main() -> None:
    try:
        download_models(COMFYUI_DIR / "models")
    except KeyboardInterrupt:
        raise SystemExit("Download interrupted. Run again to resume.") from None
    except Exception as exc:
        raise SystemExit(f"Download failed: {exc}") from exc


if __name__ == "__main__":
    main()
