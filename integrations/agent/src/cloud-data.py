"""Inventory/delete exact Happy Latent media through the private SSH channel.

No recursive deletion and no caller-provided filesystem roots. Directory handles
are pinned with O_NOFOLLOW, and every file must still match its approved digest.
"""
import contextlib
import hashlib
import json
import os
from pathlib import Path
import re
import stat


def asset_parts(asset):
    if not isinstance(asset, dict) or set(asset) != {"type", "subfolder", "filename"}:
        raise ValueError("Invalid asset descriptor")
    kind, folder, name = (asset[k] for k in ("type", "subfolder", "filename"))
    if not all(isinstance(v, str) for v in (kind, folder, name)):
        raise ValueError("Invalid asset descriptor")
    uuid = r"[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}"
    allowed = {
        ("input", "happylatent"): r"[a-f0-9]{32}\.(png|wav|mp4)",
        ("output", "happylatent/agent"): uuid + r"_(?:[0-9]+_\.(?:png|mp4)|[0-9]+\.flac)",
        ("output", "happylatent/clips"): r"[a-f0-9]{32}\.(mp4|json)",
        ("output", "happylatent/runs"): r"[a-f0-9]{64}\.json",
    }
    pattern = allowed.get((kind, folder))
    if not pattern or not re.fullmatch(pattern, name):
        raise ValueError("Asset is outside the Happy Latent media namespace")
    return [kind, *folder.split("/"), name]


def open_directory(path):
    path = Path(path)
    if not path.is_absolute():
        raise ValueError("Expected absolute root")
    current = os.open("/", os.O_RDONLY | os.O_DIRECTORY)
    try:
        for name in path.parts[1:]:
            child = os.open(name, os.O_RDONLY | os.O_DIRECTORY | os.O_NOFOLLOW, dir_fd=current)
            os.close(current)
            current = child
        return current
    except BaseException:
        os.close(current)
        raise


def open_asset(root, asset):
    parts = asset_parts(asset)
    current = open_directory(root)
    try:
        for name in parts[:-1]:
            child = os.open(name, os.O_RDONLY | os.O_DIRECTORY | os.O_NOFOLLOW, dir_fd=current)
            os.close(current)
            current = child
        source = os.open(parts[-1], os.O_RDONLY | os.O_NONBLOCK | os.O_NOFOLLOW, dir_fd=current)
        info = os.fstat(source)
        if not stat.S_ISREG(info.st_mode) or info.st_nlink != 1:
            os.close(source)
            raise ValueError("Media must be a single ordinary file")
        return current, source, info
    except BaseException:
        os.close(current)
        raise


def fingerprint(source, before):
    digest = hashlib.sha256()
    while block := os.read(source, 1024 * 1024):
        digest.update(block)
    after = os.fstat(source)
    if (before.st_size, before.st_mtime_ns, before.st_ctime_ns) != (after.st_size, after.st_mtime_ns, after.st_ctime_ns):
        raise ValueError("Media changed while inspecting it")
    return digest.hexdigest()


def run(request, *, workspace=Path("/workspace")):
    if (not isinstance(request, dict) or request.get("operation") not in {"inventory", "delete"}
            or not isinstance(request.get("files"), list) or len(request["files"]) > 2048):
        raise ValueError("Invalid cloud cleanup request")
    cloud = workspace / ".happylatent-cloud"
    runtime = cloud / "runtime"
    media = workspace
    volume_id = request.get("networkVolumeId")
    if volume_id is not None:
        runtime_id = request.get("runtimeId")
        if (not isinstance(runtime_id, str)
                or not re.fullmatch(r"[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}", runtime_id)):
            raise ValueError("Invalid runtime ID")
        runtime = cloud / "runtimes" / runtime_id
        media = runtime / "media"
    state_path = runtime / "state.json"
    parent = open_directory(state_path.parent)
    try:
        state_fd = os.open(state_path.name, os.O_RDONLY | os.O_NOFOLLOW, dir_fd=parent)
        with os.fdopen(state_fd) as handle:
            state = json.loads(handle.read(65537))
    finally:
        os.close(parent)
    if any(state.get(k) != request.get(k) or not request.get(k) for k in ("runtimeId", "podId")):
        raise ValueError("Cloud identity changed")
    if state.get("lease", {}).get("networkVolumeId") != volume_id:
        raise ValueError("Cloud storage identity changed")
    files, missing, held, seen = [], [], [], set()
    try:
        for item in request["files"]:
            asset = item.get("asset")
            parts = asset_parts(asset)
            key = "/".join(parts)
            if key in seen or item.get("category") not in {"inputs", "outputs"}:
                raise ValueError("Duplicate or invalid cleanup file")
            seen.add(key)
            try:
                parent, source, info = open_asset(media, asset)
            except FileNotFoundError:
                if request["operation"] == "delete":
                    raise ValueError("Approved file is missing; review a fresh cleanup plan") from None
                missing.append(asset)
                continue
            held.append((parent, source, info, parts[-1]))
            digest = fingerprint(source, info)
            entry = {"asset": asset, "category": item["category"], "bytes": info.st_size, "sha256": digest}
            if request["operation"] == "delete" and (item.get("bytes") != info.st_size or item.get("sha256") != digest):
                raise ValueError("Approved file changed; review a fresh cleanup plan")
            files.append(entry)
        if request["operation"] == "delete":
            # Validate the complete list before deleting its first entry.
            for parent, source, info, name in held:
                current = os.stat(name, dir_fd=parent, follow_symlinks=False)
                if (current.st_dev, current.st_ino, current.st_size, current.st_mtime_ns, current.st_ctime_ns) != (
                        info.st_dev, info.st_ino, info.st_size, info.st_mtime_ns, info.st_ctime_ns):
                    raise ValueError("Approved media changed before deletion")
            for parent, source, info, name in held:
                os.unlink(name, dir_fd=parent)
        return {"files": files, "missing": missing, "deleted": request["operation"] == "delete"}
    finally:
        for parent, source, _, _ in held:
            os.close(source)
            os.close(parent)


if __name__ == "__main__":
    try:
        print(json.dumps(run(REQUEST)))
    except Exception:
        # Paths, generated content and provider details do not belong in errors.
        print(json.dumps({"error": "Cloud files changed or could not be safely accessed. Refresh the inventory before retrying."}))
        raise SystemExit(1)
