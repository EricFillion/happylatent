"""Open editor media within its ComfyUI namespace using pinned handles."""
from contextlib import ExitStack, contextmanager
import logging
import os
from pathlib import Path
from urllib.parse import urlencode

from .project import ValidationError, validate_asset
from .safe_files import open_directory


def input_directory():
    import folder_paths
    return Path(folder_paths.get_input_directory())


def asset_url(asset):
    return "/happylatent/assets?" + urlencode(asset)


@contextmanager
def open_asset(asset, *, allow_output=False):
    import folder_paths

    asset = validate_asset(asset, allow_output=allow_output)
    base = folder_paths.get_output_directory() if asset["type"] == "output" else folder_paths.get_input_directory()
    with ExitStack() as stack:
        try:
            directory = stack.enter_context(open_directory(base, asset["subfolder"]))
            source = stack.enter_context(directory.open_file(asset["filename"]))
        except FileNotFoundError:
            raise
        except (OSError, RuntimeError, ValueError):
            logging.exception("HappyLatentVideo media open failed")
            raise ValidationError("Cannot access this media file. Use an ordinary file inside the HappyLatentVideo media folder.") from None
        yield source


def asset_fingerprint(asset):
    with open_asset(asset) as source:
        metadata = os.fstat(source.fileno())
    # Preserve metadata-based cache behavior, using the actual opened file.
    return (metadata.st_mtime_ns, metadata.st_size, getattr(metadata, "st_ctime_ns", 0),
            getattr(metadata, "st_dev", 0), getattr(metadata, "st_ino", 0))
