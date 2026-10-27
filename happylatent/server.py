"""Asset transport and read-only model detection for the embedded editor.

Generation, progress, cancellation and saving belong to ComfyUI's graph.
"""
from __future__ import annotations

import asyncio
from concurrent.futures import ThreadPoolExecutor
from contextlib import ExitStack, nullcontext
import logging
from pathlib import Path
import threading
import uuid

from aiohttp import BodyPartReader, MultipartReader, web
from server import PromptServer

from .assets import open_asset, asset_url, input_directory
from .file_response import send_file
from .images import MAX_IMAGE_PIXELS, REFERENCE_IMAGE_FORMATS
from .project import ValidationError, validate_asset
from .safe_files import open_directory
from .sampling import model_profile

MAX_UPLOAD = 256 * 1024 * 1024
WEB_ROOT = Path(__file__).resolve().parent.parent / "web"
_UPLOAD_WORKERS = ThreadPoolExecutor(thread_name_prefix="HappyLatentVideo upload")


class UploadFiles:
    """Keep handles alive until both the request and real encoder finish."""

    def __init__(self, root, identifier, kind):
        self._directories, self._files = ExitStack(), ExitStack()
        self._lock = threading.Lock()
        self._owners = 1
        self.published = False
        self.temporary_name = identifier + ".upload"
        self.output_name = identifier + (".png" if kind == "image" else ".wav")
        self._created = []
        try:
            self.directory = self._directories.enter_context(open_directory(root, "happylatent", create=True))
            self.source = self._files.enter_context(self.directory.open_file(self.temporary_name, "x+b"))
            self._created.append(self.temporary_name)
        except BaseException:
            self.release()
            raise

    def create_output(self):
        self.output = self._files.enter_context(self.directory.open_file(self.output_name, "xb"))
        self._created.append(self.output_name)

    def retain(self):
        with self._lock:
            self._owners += 1

    def release(self):
        with self._lock:
            self._owners -= 1
            if self._owners:
                return
        try:
            self._files.close()
        finally:
            try:
                for name in self._created:
                    if not self.published or name == self.temporary_name:
                        try:
                            self.directory.unlink(name)
                        except OSError:
                            logging.exception("HappyLatentVideo upload cleanup failed")
            finally:
                self._directories.close()


async def _wait_for_conversion(future):
    return await asyncio.wrap_future(future)


class UploadStream:
    """Apply ComfyUI's request limit to multipart headers and streamed file data."""

    def __init__(self, request):
        self.content = request.content
        self.limit = request.client_max_size
        self.check_size(request.content_length or 0)

    def check_size(self, size=0):
        size = max(size, self.content.total_bytes)
        if self.limit and size > self.limit:
            raise web.HTTPRequestEntityTooLarge(max_size=self.limit, actual_size=size)

    async def read(self, size=-1):
        self.check_size()
        try:
            return await self.content.read(size)
        finally:
            self.check_size()

    async def readline(self, *args, **kwargs):
        self.check_size()
        try:
            return await self.content.readline(*args, **kwargs)
        finally:
            self.check_size()

    def at_eof(self):
        return self.content.at_eof()

    def unread_data(self, data):
        self.content.unread_data(data)


def prepare_upload(kind, temporary, output):
    """Normalize an upload in a worker thread before publishing its metadata."""
    if kind == "image":
        from PIL import Image, ImageOps
        try:
            source_context = nullcontext(temporary) if hasattr(temporary, "read") else open(temporary, "rb")
            with source_context as source, Image.open(source, formats=REFERENCE_IMAGE_FORMATS) as image:
                if image.width * image.height > MAX_IMAGE_PIXELS:
                    raise ValidationError("Image exceeds 40 million pixels.")
                normalized = ImageOps.exif_transpose(image).convert("RGB")
        except ValidationError:
            raise
        except (OSError, ValueError, EOFError, SyntaxError, Image.DecompressionBombError):
            logging.exception("HappyLatentVideo uploaded image decoding failed")
            raise ValidationError("Use a self-contained PNG, JPEG or WebP image.") from None
        # Keep storage/encoder failures distinct from unsupported source formats.
        # The route logs these and returns its generic server-log error.
        with normalized:
            normalized.save(output, format="PNG")
            return {"width": normalized.width, "height": normalized.height}
    from .media import SAMPLE_RATE, decode_audio, write_wav
    samples = decode_audio(temporary)
    if not samples.shape[1]:
        raise ValidationError("The audio file has no samples.")
    write_wav(output, samples)
    return {"duration": samples.shape[1] / SAMPLE_RATE, "sampleCount": samples.shape[1], "sampleRate": SAMPLE_RATE}


def register_routes():
    server = PromptServer.instance
    if getattr(server, "_happylatent_registered", False):
        return
    server._happylatent_registered = True
    routes = server.routes

    @routes.post("/happylatent/model-profile")
    async def read_model_profile(request):
        try:
            payload = await request.json()
            if not isinstance(payload, dict) or not isinstance(payload.get("prompt"), dict):
                raise ValueError("Model profile needs a ComfyUI API prompt object.")
            return web.json_response(model_profile(payload.get("model"), payload["prompt"]))
        except (ValueError, TypeError):
            return web.json_response({"error": "Model profile needs a ComfyUI API prompt object."}, status=400)

    @routes.get("/happylatent/assets")
    async def read_asset(request):
        try:
            asset = validate_asset(dict(request.query), allow_output=True)
            if Path(asset["filename"]).suffix.lower() not in (".png", ".jpg", ".jpeg", ".webp", ".wav", ".mp4"):
                raise web.HTTPNotFound(text="Media file not found.")
            with open_asset(asset, allow_output=True) as source:
                return await send_file(request, source, filename=asset["filename"])
        except FileNotFoundError:
            raise web.HTTPNotFound(text="Media file not found.")
        except ValidationError as error:
            raise web.HTTPBadRequest(text=str(error))
        except (OSError, RuntimeError, ValueError):
            logging.exception("HappyLatentVideo media lookup failed")
            raise web.HTTPBadRequest(text="Cannot read this media file.")

    @routes.post("/happylatent/assets")
    async def upload(request):
        kind = request.query.get("kind")
        if kind not in ("image", "audio"):
            return web.json_response({"error": "Upload kind must be image or audio."}, status=400)
        try:
            files = UploadFiles(input_directory(), uuid.uuid4().hex, kind)
        except (OSError, RuntimeError, ValueError):
            logging.exception("HappyLatentVideo media directory is unavailable")
            return web.json_response({"error": f"Cannot import this {kind}: the HappyLatentVideo media folder is unavailable or contains a symlink."}, status=400)
        try:
            stream = UploadStream(request)
            reader = MultipartReader(request.headers, stream)
            field = await reader.next()
            if not isinstance(field, BodyPartReader) or field.name != "file":
                raise ValidationError("Upload must contain a multipart file field.")
            size = 0
            while chunk := await field.read_chunk():
                size += len(chunk)
                if size > MAX_UPLOAD:
                    raise ValidationError("Upload exceeds 256 MB.")
                files.source.write(chunk)
            if not size:
                raise ValidationError("The uploaded file is empty.")
            if await reader.next() is not None:
                raise ValidationError("Upload must contain only one file field.")
            # Include any multipart epilogue in the host's whole-request limit.
            while await stream.read(8192):
                pass

            files.source.seek(0)
            files.create_output()
            files.retain()
            try:
                conversion = _UPLOAD_WORKERS.submit(prepare_upload, kind, files.source, files.output)
            except BaseException:
                files.release()
                raise
            # This callback follows the actual thread, even if shutdown cancels
            # its asyncio wrapper. A cancelled queued job also releases ownership.
            conversion.add_done_callback(lambda _: files.release())
            worker = asyncio.create_task(_wait_for_conversion(conversion))
            try:
                metadata = await asyncio.shield(worker)
            except asyncio.CancelledError:
                # Further request cancellations must not cancel the wrapper:
                # cancelling a future cannot stop an encoder that is running.
                while not worker.done():
                    try:
                        await asyncio.shield(worker)
                    except asyncio.CancelledError:
                        continue
                    except Exception:
                        break
                try:
                    worker.result()
                except (Exception, asyncio.CancelledError):
                    # The request is already cancelled; preserve cancellation
                    # even if the encoder subsequently fails.
                    pass
                raise
            files.output.flush()
            asset = {"filename": files.output_name, "subfolder": "happylatent", "type": "input"}
            response = web.json_response({"asset": asset, "url": asset_url(asset), **metadata}, status=201)
            files.published = True
            return response
        except web.HTTPRequestEntityTooLarge:
            raise
        except ValidationError as error:
            return web.json_response({"error": f"Cannot import this {kind}: {error}"}, status=400)
        except Exception:
            logging.exception("HappyLatentVideo %s import failed", kind)
            return web.json_response({"error": f"Cannot import this {kind}. Check the file and server log."}, status=400)
        finally:
            files.release()

    @routes.get("/happylatent/ui/{file:.*}")
    async def static_file(request):
        try:
            relative = request.match_info["file"]
            if Path(relative).suffix not in (".js", ".css", ".map"):
                raise web.HTTPNotFound()
            parent, _, name = relative.rpartition("/")
            with open_directory(WEB_ROOT, parent) as directory, directory.open_file(name) as source:
                return await send_file(request, source, filename=name, headers={"Cache-Control": "no-cache"})
        except (OSError, RuntimeError, ValueError):
            raise web.HTTPNotFound()
