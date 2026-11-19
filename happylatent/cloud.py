"""Non-secret cloud identity and a narrowly scoped watchdog stop request."""
from __future__ import annotations

import json
import os
import re
import datetime as dt
from pathlib import Path
import uuid


def storage_usage():
    """Measure the entire managed volume, not just recorded Happy Latent media."""
    try:
        usage = os.statvfs("/workspace")
        total = usage.f_blocks * usage.f_frsize
        available = usage.f_bavail * usage.f_frsize
        if not 0 <= available <= total or total <= 0:
            raise ValueError("Invalid filesystem capacity")
        return {"status": "measured", "path": "/workspace", "totalBytes": total,
                "freeBytes": available,
                "measuredAt": dt.datetime.now(dt.timezone.utc).isoformat()}
    except (OSError, ValueError, AttributeError):
        # No host paths, provider credentials, or arbitrary exception text.
        return {"status": "unavailable", "path": "/workspace"}


def _state_path():
    configured = os.environ.get("HAPPYLATENT_CLOUD_STATE")
    if not configured:
        raise FileNotFoundError("This is not a managed cloud runtime.")
    return Path(configured)


def cloud_status():
    path = _state_path()
    if path.stat().st_size > 65536:
        raise ValueError("Invalid cloud state.")
    state = json.loads(path.read_text())
    lease = state["lease"]
    watchdog = state.get("watchdog", {})
    # Never return arbitrary state/environment or exception text. The runtime
    # supervisor and its scoped key are deliberately outside ComfyUI.
    models = {}
    for key in ("verifiedModels", "cachedModels"):
        values = state.get(key)
        if isinstance(values, list) and len(values) <= 64 and all(
            isinstance(value, str) and re.fullmatch(r"[a-f0-9]{64}", value) for value in values
        ):
            models[key] = values
    return {
        **models,
        "version": 1,
        "runtimeId": state["runtimeId"],
        "podId": state["podId"],
        "deadline": lease["deadline"],
        "media": lease["media"],
        **({"modelInstallVersion": 1} if state.get("modelInstallVersion") == 1 else {}),
        **({"networkVolumeId": lease["networkVolumeId"]} if "networkVolumeId" in lease else {}),
        "status": state["status"],
        "watchdog": {key: watchdog.get(key) for key in ("status", "heartbeatAt")},
        "storage": storage_usage(),
    }


def request_cloud_stop(payload):
    state = cloud_status()
    if not isinstance(payload, dict) or set(payload) != {"runtimeId", "podId"}:
        raise ValueError("Supply exactly the cloud runtimeId and podId.")
    if any(payload[key] != state[key] for key in payload):
        raise ValueError("Cloud runtime identity mismatch.")
    requests = os.environ.get("HAPPYLATENT_CLOUD_STOP_DIR")
    directory = Path(requests) if requests else _state_path().parent
    if requests and (directory != _state_path().parent / "render-requests" or directory.is_symlink() or not directory.is_dir()):
        raise ValueError("Invalid cloud stop request directory.")
    destination = directory / "stop-request"
    temporary = destination.with_name(".stop-" + uuid.uuid4().hex)
    try:
        with temporary.open("x") as handle:
            os.chmod(temporary, 0o600)
            json.dump(payload, handle)
        os.replace(temporary, destination)
    finally:
        temporary.unlink(missing_ok=True)
    return {"status": "stop_requested", "podId": state["podId"]}
