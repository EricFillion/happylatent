"""Decode self-contained reference images without secondary file or network I/O."""
from __future__ import annotations

import hashlib
import json
import logging

from .assets import open_asset
from .project import ValidationError, validate_asset

MAX_IMAGE_PIXELS = 40_000_000
REFERENCE_IMAGE_FORMATS = ("PNG", "JPEG", "WEBP")


def parse_image_asset(value):
    def reject_constant(_):
        raise ValueError("Nonstandard JSON constant")

    try:
        asset = json.loads(value, parse_constant=reject_constant)
    except (TypeError, ValueError):
        raise ValidationError("Reference image asset must be valid JSON.") from None
    return validate_asset(asset)


def validate_reference_image(asset):
    try:
        with open_asset(asset):
            pass
    except FileNotFoundError:
        raise ValidationError("Reference image file is missing.") from None
    except ValidationError:
        raise
    except (OSError, RuntimeError):
        logging.exception("HappyLatentVideo reference image lookup failed")
        raise ValidationError("Cannot access this reference image.") from None


def reference_image_fingerprint(asset):
    try:
        digest = hashlib.sha256()
        with open_asset(asset) as source:
            for chunk in iter(lambda: source.read(1024 * 1024), b""):
                digest.update(chunk)
        return digest.hexdigest()
    except (OSError, RuntimeError):
        logging.exception("HappyLatentVideo reference image fingerprint failed")
        raise ValidationError("Cannot read this reference image.") from None


def load_reference_image(asset):
    import numpy as np
    from PIL import Image, ImageOps, ImageSequence
    import torch

    try:
        # Give only the selected file handle to explicitly permitted raster
        # plugins. Never pass this path to FFmpeg or auto-select delegate formats.
        with open_asset(asset) as source, Image.open(source, formats=REFERENCE_IMAGE_FORMATS) as image:
            frames = []
            size = None
            for frame in ImageSequence.Iterator(image):
                if frame.width * frame.height > MAX_IMAGE_PIXELS:
                    raise ValidationError("Reference image exceeds 40 million pixels.")
                frame = ImageOps.exif_transpose(frame)
                if size is None:
                    size = frame.size
                if frame.size != size:
                    continue
                if frame.mode in ("I;16", "I;16L", "I;16B") or (frame.mode == "I" and image.format == "PNG"):
                    # Pillow's RGB conversion clips 16-bit gray to 8-bit values.
                    # Normalize the actual range before expanding it to RGB.
                    gray = np.array(frame, dtype=np.float32) / 65535.0
                    pixels = np.repeat(gray[..., None], 3, axis=-1)
                else:
                    pixels = np.array(frame.convert("RGB"), dtype=np.float32) / 255.0
                frames.append(pixels)
            if not frames:
                raise ValidationError("Reference image contains no frames.")
        return torch.from_numpy(np.stack(frames))
    except ValidationError:
        raise
    except (OSError, RuntimeError, ValueError, EOFError, SyntaxError, Image.DecompressionBombError):
        logging.exception("HappyLatentVideo reference image decoding failed")
        raise ValidationError("Cannot decode reference image. Use a self-contained PNG, JPEG or WebP image.") from None
