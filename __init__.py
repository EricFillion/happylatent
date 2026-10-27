"""ComfyUI loads this package as a custom extension."""
from .happylatent.nodes import NODE_CLASS_MAPPINGS, NODE_DISPLAY_NAME_MAPPINGS

WEB_DIRECTORY = "./extension"

try:
    from .happylatent.server import register_routes
    register_routes()
except ImportError as error:
    # Importing pure utilities in development must not require a running ComfyUI.
    if error.name not in ("server", "folder_paths", "aiohttp"):
        raise

__all__ = ["NODE_CLASS_MAPPINGS", "NODE_DISPLAY_NAME_MAPPINGS", "WEB_DIRECTORY"]
