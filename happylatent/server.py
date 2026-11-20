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
from .cloud import cloud_status, request_cloud_stop
from .file_response import send_file
from .images import MAX_IMAGE_PIXELS, REFERENCE_IMAGE_FORMATS
from .project import ValidationError, validate_asset
from .safe_files import open_directory
from .sampling import model_profile
from .speech import speech_setup_status

MAX_UPLOAD = 256 * 1024 * 1024
WEB_ROOT = Path(__file__).resolve().parent.parent / "web"
_UPLOAD_WORKERS = ThreadPoolExecutor(thread_name_prefix="HappyLatentVideo upload")
_MUSIC_WORKERS = ThreadPoolExecutor(max_workers=2, thread_name_prefix="HappyLatent music analysis")


def analyze_music_asset(payload):
    """Analyze a pinned input/output handle; never accept an arbitrary path or URL."""
    from .music_analysis import analyze_music

    fields = {"asset", "startSeconds", "endSeconds", "targetDurationSeconds"}
    if not isinstance(payload, dict) or set(payload) - fields or "asset" not in payload:
        raise ValidationError("Music analysis needs an asset and optional analysis range or target duration.")
    asset = validate_asset(payload["asset"], allow_output=True)
    if Path(asset["filename"]).suffix.lower() not in (".wav", ".flac", ".mp3", ".ogg", ".m4a", ".aac"):
        raise ValidationError("Choose an audio asset for music analysis.")
    options = {target: payload[key] for key, target in (
        ("startSeconds", "start_seconds"), ("endSeconds", "end_seconds"),
        ("targetDurationSeconds", "target_duration_seconds")) if key in payload}
    with open_asset(asset, allow_output=True) as source:
        analysis = analyze_music(source, **options)
    return {"asset": asset, "analysis": analysis}


class UploadFiles:
    """Keep handles alive until both the request and real encoder finish."""

    def __init__(self, root, identifier, kind):
        self._directories, self._files = ExitStack(), ExitStack()
        self._lock = threading.Lock()
        self._owners = 1
        self.published = False
        self.temporary_name = identifier + ".upload"
        self.output_name = identifier + {"image": ".png", "audio": ".wav", "video": ".mp4"}[kind]
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
    if kind == "video":
        from .video_media import transcode_video
        metadata, _ = transcode_video(temporary, output)
        return dict(metadata, duration=metadata["frameCount"] / metadata["fps"])
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

    @routes.get("/happylatent/clips")
    async def clips_catalog(request):
        from .clips import list_clips
        clips = await asyncio.to_thread(list_clips, request.query.get("projectId"), request.query.get("runId"))
        return web.json_response({"clips": clips})

    @routes.get("/happylatent/runs/{run_id}")
    @routes.get("/happylatent/clips/runs/{run_id}")
    async def clips_run(request):
        from .clips import read_run
        try:
            return web.json_response(await asyncio.to_thread(read_run, request.match_info["run_id"]))
        except FileNotFoundError:
            raise web.HTTPNotFound(text="No saved clips for this run.")
        except (ValueError, OSError):
            return web.json_response({"error": "Cannot read this clip run."}, status=400)

    @routes.get("/happylatent/clips/{clip_id}")
    async def clip_record(request):
        from .clips import read_clip
        try:
            return web.json_response(await asyncio.to_thread(read_clip, request.match_info["clip_id"]))
        except FileNotFoundError:
            raise web.HTTPNotFound(text="No saved clip with this ID.")
        except (ValueError, OSError):
            return web.json_response({"error": "Cannot read this clip."}, status=400)

    @routes.get("/happylatent/speech-status")
    async def read_speech_status(request):
        # Discovery is read-only; it never imports Kokoro or installs packages.
        return web.json_response(await asyncio.to_thread(speech_setup_status))

    @routes.post("/happylatent/music/analyze")
    async def read_music_analysis(request):
        try:
            payload = await request.json()
            result = await asyncio.get_running_loop().run_in_executor(_MUSIC_WORKERS, analyze_music_asset, payload)
            return web.json_response(result)
        except FileNotFoundError:
            raise web.HTTPNotFound(text="Music asset not found on this runtime.")
        except (ValueError, TypeError) as error:
            return web.json_response({"error": str(error)}, status=400)
        except (OSError, RuntimeError, ImportError) as error:
            logging.exception("HappyLatent music analysis failed")
            return web.json_response({"error": "Music analysis could not decode this asset on the selected runtime."}, status=422)

    @routes.get("/happylatent/cloud")
    async def read_cloud_status(request):
        try:
            return web.json_response(cloud_status())
        except FileNotFoundError:
            raise web.HTTPNotFound(text="No managed cloud runtime.")
        except (OSError, ValueError, KeyError, TypeError):
            raise web.HTTPServiceUnavailable(text="Cloud watchdog state is unavailable.")

    @routes.post("/happylatent/cloud/stop")
    async def stop_cloud(request):
        if request.remote not in ("127.0.0.1", "::1"):
            raise web.HTTPForbidden(text="Use the private SSH tunnel.")
        try:
            payload = await request.json()
            if server.prompt_queue.get_tasks_remaining() != 0:
                raise web.HTTPConflict(text="Wait for the cloud generation queue to empty before stopping.")
            return web.json_response(request_cloud_stop(payload))
        except FileNotFoundError:
            raise web.HTTPNotFound(text="No managed cloud runtime.")
        except (ValueError, KeyError, TypeError):
            raise web.HTTPBadRequest(text="Cloud runtime identity mismatch or invalid stop request.")
        except OSError:
            raise web.HTTPServiceUnavailable(text="Cannot notify the cloud watchdog.")

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
        if kind not in ("image", "audio", "video"):
            return web.json_response({"error": "Upload kind must be image, audio or video."}, status=400)
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
            if kind == "video":
                from .clips import register_import
                metadata["clip"] = register_import(asset, metadata, Path(field.filename or "Imported clip").stem)
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
