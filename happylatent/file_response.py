"""Serve an already validated file descriptor without looking up its path again."""
from __future__ import annotations

import asyncio
from concurrent.futures import ThreadPoolExecutor
import os
from pathlib import PurePath
import re
import stat

from aiohttp import web


CHUNK_SIZE = 256 * 1024
_FILE_WORKERS = ThreadPoolExecutor(thread_name_prefix="HappyLatentVideo file")
CONTENT_TYPES = {
    ".png": "image/png",
    ".jpg": "image/jpeg",
    ".jpeg": "image/jpeg",
    ".webp": "image/webp",
    ".wav": "audio/x-wav",
    ".mp4": "video/mp4",
    ".js": "text/javascript",
    ".css": "text/css",
    ".map": "application/json",
}


def _etag_matches(values, tag, *, weak=False):
    return any(value.value == "*" or (value.value == tag and (weak or not value.is_weak))
               for value in values)


def _range_bounds(value, size):
    """Resolve one byte range to an offset and length, rejecting empty ranges."""
    match = re.fullmatch(r"bytes=(\d*)-(\d*)", value)
    if match is None or not any(match.groups()) or not size:
        raise ValueError("Unsupported byte range.")
    first, last = match.groups()
    if first:
        start = int(first)
        end = min(int(last) + 1, size) if last else size
        if start >= end:
            raise ValueError("Unsatisfiable byte range.")
    else:
        length = int(last)
        if not length:
            raise ValueError("Empty byte range.")
        start, end = max(0, size - length), size
    return start, end - start


async def _read_chunk(source, offset, size):
    def read():
        source.seek(offset)
        return source.read(size)

    # A to_thread Task can become cancelled before its real thread has finished,
    # especially when asyncio shutdown cancels every task. Track the actual
    # concurrent Future so the caller can safely close the source on our return.
    worker = _FILE_WORKERS.submit(read)
    try:
        return await asyncio.shield(asyncio.wrap_future(worker))
    except asyncio.CancelledError:
        while not worker.done():
            try:
                await asyncio.shield(asyncio.wrap_future(worker))
            except asyncio.CancelledError:
                continue
            except Exception:
                break
        try:
            worker.result()
        except (Exception, asyncio.CancelledError):
            pass
        raise


async def send_file(request, source, *, filename, headers=None):
    """Send a regular binary handle; the caller keeps it open until we return.

    ``filename`` selects only a MIME type. No pathname is opened or probed,
    including compressed sidecars that a pathname-based FileResponse may serve.
    """
    info = os.fstat(source.fileno())
    if not stat.S_ISREG(info.st_mode):
        raise web.HTTPForbidden(text="Only regular files can be served.")

    response = web.StreamResponse(headers=headers)
    response.content_type = CONTENT_TYPES.get(PurePath(filename).suffix.lower(), "application/octet-stream")
    response.headers["X-Content-Type-Options"] = "nosniff"
    response.headers["Accept-Ranges"] = "bytes"
    tag = f"{info.st_mtime_ns:x}-{info.st_size:x}"
    response.etag = tag
    response.last_modified = info.st_mtime
    start, count = 0, info.st_size

    if_match = request.if_match
    if_none_match = request.if_none_match
    modified_since = request.if_modified_since
    unmodified_since = request.if_unmodified_since
    if ((if_match is not None and not _etag_matches(if_match, tag))
            or (if_match is None and unmodified_since is not None
                and info.st_mtime > unmodified_since.timestamp())):
        response.set_status(412)
        count = 0
    elif ((if_none_match is not None and _etag_matches(if_none_match, tag, weak=True))
          or (if_none_match is None and modified_since is not None
              and info.st_mtime <= modified_since.timestamp())):
        response.set_status(304 if request.method in ("GET", "HEAD") else 412)
        count = 0
    else:
        range_header = request.headers.get("Range")
        if_range = request.headers.get("If-Range")
        # aiohttp exposes If-Range dates but not entity tags. Handle both forms;
        # weak tags and malformed validators do not permit a partial response.
        range_allowed = (if_range is None or if_range == response.headers["ETag"]
                         or (request.if_range is not None
                             and info.st_mtime <= request.if_range.timestamp()))
        if range_header is not None and range_allowed:
            try:
                start, count = _range_bounds(range_header, info.st_size)
            except ValueError:
                response.set_status(416)
                response.headers["Content-Range"] = f"bytes */{info.st_size}"
                count = 0
            else:
                response.set_status(206)
                response.headers["Content-Range"] = f"bytes {start}-{start + count - 1}/{info.st_size}"

    if response.status != 304:
        response.content_length = count
    await response.prepare(request)
    if request.method != "HEAD":
        while count:
            chunk = await _read_chunk(source, start, min(CHUNK_SIZE, count))
            if not chunk:
                # A local writer truncated the same inode during transmission.
                # Do not leave a keep-alive connection with an incomplete body.
                if request.transport is not None:
                    request.transport.close()
                raise OSError("File changed while it was being served.")
            await response.write(chunk)
            start += len(chunk)
            count -= len(chunk)
    await response.write_eof()
    return response
