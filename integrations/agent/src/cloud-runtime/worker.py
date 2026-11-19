#!/usr/bin/env python3
"""Happy Latent pod supervisor. A best-effort lease, not a provider billing cap.

The watchdog runs independently of setup/downloads/ComfyUI. Managed setup,
download and ComfyUI children do not inherit Runpod's injected Pod-scoped key.
The native template's PID 1 and root remain trusted. No account key is shipped.
"""
from __future__ import annotations

import base64
import contextlib
import ctypes
import datetime as dt
import fcntl
import hashlib
import json
import math
import os
from pathlib import Path, PurePosixPath
import pwd
import re
import signal
import shutil
import stat
import subprocess
import sys
import tempfile
import time
import urllib.error
import urllib.request
import uuid


WORKSPACE = Path("/workspace")
STATE_PATH = os.environ.get("HAPPYLATENT_CLOUD_STATE", str(WORKSPACE / ".happylatent-cloud/runtime/state.json"))
RUNTIME_ROOT = Path(STATE_PATH).parent
BUNDLE_ROOT = Path(os.environ.get("HAPPYLATENT_CLOUD_BUNDLE", "/nonexistent-happylatent-bundle"))
COMFY_ROOT = RUNTIME_ROOT / "ComfyUI"
RUNTIME_PYTHON = RUNTIME_ROOT / "venv" / "bin" / "python"
MANIFEST = BUNDLE_ROOT / "models.json"
STOPPED = {"EXITED", "TERMINATED"}


def runtime_root(workspace: Path, lease: dict) -> Path:
    cloud = workspace / ".happylatent-cloud"
    if lease.get("networkVolumeId"):
        return cloud / "runtimes" / lease["runtimeId"]
    return cloud / "runtime"


def media_root(workspace: Path, runtime: Path) -> Path:
    if runtime.parent == workspace / ".happylatent-cloud" / "runtimes":
        return runtime / "media"
    return workspace


def worker_command(python: str | Path, script: str | Path, *arguments: str) -> list[str]:
    """Run the verified source with its original argv, __file__, and main guard.

    Direct script launches were killed on a live Runpod template while this
    standard-library entry point successfully armed the same watchdog.
    Keep paths and mode flags as separate arguments; credentials stay in env.
    """
    entry = ("import runpy,sys; source=sys.argv.pop(1); sys.argv[0]=source; "
             "runpy.run_path(source, run_name='__main__')")
    return [str(python), "-B", "-c", entry, str(script), *arguments]


def timestamp(value: str) -> float:
    parsed = dt.datetime.fromisoformat(value.replace("Z", "+00:00"))
    if parsed.tzinfo is None:
        raise ValueError("Lease timestamps must contain a timezone")
    return parsed.timestamp()


def iso_now() -> str:
    return dt.datetime.now(dt.timezone.utc).isoformat().replace("+00:00", "Z")


def read_lease(encoded: str) -> dict:
    try:
        lease = json.loads(base64.b64decode(encoded, validate=True))
        if lease["version"] != 1 or str(uuid.UUID(lease["runtimeId"])) != lease["runtimeId"]:
            raise ValueError()
        if lease["media"] not in {"video", "image", "both", "music", "all"}:
            raise ValueError()
        if "bundleId" in lease and (not isinstance(lease["bundleId"], str) or not re.fullmatch(r"[0-9a-f]{64}", lease["bundleId"])):
            raise ValueError()
        start, deadline = timestamp(lease["createdAt"]), timestamp(lease["deadline"])
        if deadline <= start:
            raise ValueError()
        budget = lease["budget"]
        for name in ("maxTotalUsd", "maxHourlyUsd", "quotedHourlyUsd", "maxMinutes", "reserveSeconds"):
            value = budget[name]
            if isinstance(value, bool) or not isinstance(value, (int, float)) or not math.isfinite(value):
                raise ValueError()
            if value < 0 or (name != "reserveSeconds" and value == 0):
                raise ValueError()
        if budget["quotedHourlyUsd"] > budget["maxHourlyUsd"]:
            raise ValueError()
        allowed = min(budget["maxMinutes"] * 60,
                      budget["maxTotalUsd"] / budget["quotedHourlyUsd"] * 3600) - budget["reserveSeconds"]
        if deadline - start > allowed + 1:
            raise ValueError()
        key = lease["sshPublicKey"]
        if not isinstance(key, str) or "\n" in key or "\r" in key or len(key) > 16384:
            raise ValueError()
        fields = key.split()
        if len(fields) < 2 or fields[0] not in {"ssh-ed25519", "ssh-rsa", "ecdsa-sha2-nistp256", "ecdsa-sha2-nistp384", "ecdsa-sha2-nistp521"}:
            raise ValueError()
        base64.b64decode(fields[1], validate=True)
    except (ValueError, KeyError, TypeError, AttributeError, OverflowError):
        raise ValueError("Invalid cloud lease") from None
    # Persist only the defined, nonsecret fields. Ignore arbitrary caller metadata.
    result = {k: lease[k] for k in ("version", "runtimeId", "deadline", "createdAt", "media", "sshPublicKey")}
    if "bundleId" in lease:
        result["bundleId"] = lease["bundleId"]
    if "networkVolumeId" in lease:
        volume = lease["networkVolumeId"]
        if not isinstance(volume, str) or not re.fullmatch(r"[A-Za-z0-9_-]{1,128}", volume):
            raise ValueError("Invalid Runpod Network Volume ID")
        result["networkVolumeId"] = volume
    if "containerDiskGb" in lease:
        disk = lease["containerDiskGb"]
        if type(disk) is not int or disk <= 0 or "networkVolumeId" in lease:
            raise ValueError("Invalid Runpod container disk")
        result["containerDiskGb"] = disk
    if "downloadApproval" in lease:
        approval = lease["downloadApproval"]
        if (not isinstance(approval, dict) or set(approval) != {"payload", "signature"}
                or any(not isinstance(approval[key], str) for key in approval)
                or len(approval["payload"]) > 65536 or len(approval["signature"]) > 128):
            raise ValueError("Invalid download approval")
        result["downloadApproval"] = approval
    result["budget"] = {k: budget[k] for k in ("maxTotalUsd", "maxHourlyUsd", "quotedHourlyUsd", "maxMinutes", "reserveSeconds")}
    return result


def private_directory(path: Path, mode: int = 0o700) -> None:
    path.mkdir(parents=True, exist_ok=True, mode=mode)
    if path.is_symlink() or not path.is_dir():
        raise ValueError("Private runtime directory is not a regular directory")
    path.chmod(mode)


def atomic_json(path: Path, data: dict, *, readable: bool = False) -> None:
    private_directory(path.parent, 0o711 if readable else 0o700)
    fd, temp = tempfile.mkstemp(prefix=".state-", dir=path.parent)
    try:
        with os.fdopen(fd, "w") as handle:
            if readable:
                os.fchmod(handle.fileno(), 0o644)
            json.dump(data, handle)
            handle.flush()
            os.fsync(handle.fileno())
        os.replace(temp, path)
    finally:
        with contextlib.suppress(FileNotFoundError):
            os.unlink(temp)


def update_state(path: Path, *, stage: str | None = None, **updates) -> dict:
    readable = renderer_identity(path.parent, required=False) is not None
    private_directory(path.parent, 0o711 if readable else 0o700)
    lock_fd = os.open(str(path) + ".lock", os.O_CREAT | os.O_RDWR | os.O_NOFOLLOW, 0o600)
    with os.fdopen(lock_fd, "r+") as lock:
        fcntl.flock(lock, fcntl.LOCK_EX)
        try:
            state = json.loads(path.read_text()) if path.exists() else {}
            state.update(updates)
            if stage is not None:
                state.setdefault("setupStages", {}).setdefault(stage, iso_now())
            atomic_json(path, state, readable=readable)
            return state
        finally:
            fcntl.flock(lock, fcntl.LOCK_UN)


def load_state(path: Path) -> dict:
    return json.loads(path.read_text())


def persist_lease(lease: dict, root: Path = WORKSPACE) -> None:
    directory = root / ".happylatent-cloud" / "leases"
    private_directory(directory)
    path = directory / (lease["runtimeId"] + ".json")
    if path.exists():
        if path.is_symlink() or json.loads(path.read_text()) != lease:
            raise ValueError("A runtime lease cannot be replaced or extended")
    else:
        atomic_json(path, lease)


class NoRedirect(urllib.request.HTTPRedirectHandler):
    def redirect_request(self, *args, **kwargs):
        return None


class ExistingModelConflict(ValueError):
    """A model on the persistent volume differs from the approved manifest."""


def pod_request(pod_id: str, api_key: str, action: str | None = None, *, opener=None) -> dict:
    """Use only the provider origin; never follow a redirect carrying a key."""
    if not re.fullmatch(r"[A-Za-z0-9_-]{3,128}", pod_id) or not api_key:
        raise ValueError("Injected pod credentials are unavailable")
    url = "https://api.runpod.io/v2/pods/" + pod_id
    data = None
    if action is not None:
        if action != "stop":
            raise ValueError("The worker can only stop itself")
        url += "/action"
        data = b'{"action":"stop"}'
    req = urllib.request.Request(url, data=data, headers={
        "Authorization": "Bearer " + api_key, "Content-Type": "application/json",
        "User-Agent": "HappyLatent-Cloud/1", "Accept": "application/json",
    })
    with (opener or urllib.request.build_opener(urllib.request.ProxyHandler({}), NoRedirect())).open(req, timeout=10) as response:
        body = response.read(1024 * 1024 + 1)
    if len(body) > 1024 * 1024:
        raise ValueError("Provider response exceeded limit")
    payload = json.loads(body)
    if payload.get("id") != pod_id:
        raise ValueError("Provider response does not match this pod")
    # Provider responses contain environment variables. Do not keep or log those.
    return {"id": pod_id, "status": payload.get("status"), "actions": payload.get("actions", []), "cost": payload.get("cost")}


class InsufficientStorage(RuntimeError):
    """The approved missing model batch does not fit with a small reserve."""


def safe_error(error: BaseException) -> str:
    # Exception bodies/URLs may contain secrets. Report only a fixed category.
    if isinstance(error, ExistingModelConflict):
        return "existing_model_conflict: move the mismatching model out of the dedicated volume's models directory before retrying"
    if isinstance(error, InsufficientStorage):
        return "insufficient_cloud_storage: increase the volume with spending approval or review retrieved-media cleanup before retrying; no models were deleted"
    if isinstance(error, urllib.error.HTTPError):
        return "provider_http_" + str(error.code)
    if isinstance(error, (TimeoutError, urllib.error.URLError)):
        return "provider_connection_failed"
    return type(error).__name__


def stop_once(pod_id: str, key: str, request=pod_request) -> bool:
    try:
        result = request(pod_id, key, "stop")
    except urllib.error.HTTPError as error:
        error.close()
        if error.code != 409:
            raise
        result = request(pod_id, key)
    return result["status"] in STOPPED


def request_stop(path: Path, reason: str) -> None:
    update_state(path, status="stopping", stopRequestedAt=iso_now(), stopReason=reason)


def stop_marker_exists(path: Path, lease: dict, pod_id: str) -> bool:
    # An empty file is supported for a local administrator. The HTTP route writes
    # an identity-bound JSON record so one runtime cannot stop a later runtime.
    for marker in (path.with_name("stop-request"), path.parent / "render-requests" / "stop-request"):
        try:
            with os.fdopen(os.open(marker, os.O_RDONLY | os.O_NOFOLLOW | os.O_NONBLOCK), "r") as handle:
                info = os.fstat(handle.fileno())
                if not stat.S_ISREG(info.st_mode) or info.st_size > 4096:
                    continue
                content = handle.read(4097)
            if not content.strip() and marker.parent == path.parent:
                return True
            request = json.loads(content)
            if request.get("runtimeId") == lease["runtimeId"] and request.get("podId") == pod_id:
                return True
        except (OSError, ValueError, AttributeError):
            pass
    return False


def watchdog_loop(lease: dict, path: Path, pod_id: str, key: str, *,
                  request=pod_request, clock=time.time, monotonic=time.monotonic,
                  sleep=time.sleep) -> int:
    if not key or not pod_id:
        update_state(path, status="failed", error="pod_credentials_missing",
                     watchdog={"status": "unarmed", "heartbeatAt": iso_now()})
        return 1
    deadline = timestamp(lease["deadline"])
    monotonic_deadline = monotonic() + max(0, deadline - clock())
    # A successful read does not prove the scoped key can stop the pod. The state
    # deliberately reports this as unverified until an actual stop succeeds.
    try:
        result = request(pod_id, key)
        if result["status"] in STOPPED:
            update_state(path, status="stopped", watchdog={"status": "stopped", "heartbeatAt": iso_now()})
            return 0
        if "stop" not in result["actions"]:
            raise ValueError("Pod does not offer a stop action")
        cost = result.get("cost")
        if (isinstance(cost, bool) or not isinstance(cost, (float, int)) or not math.isfinite(cost)
                or cost < 0 or cost > min(lease["budget"]["maxHourlyUsd"], lease["budget"]["quotedHourlyUsd"]) + 1e-9):
            raise ValueError("Actual compute rate cannot be verified within the approved quote")
    except Exception as error:
        update_state(path, status="failed", error="preflight_" + safe_error(error),
                     watchdog={"status": "unarmed", "heartbeatAt": iso_now()})
        # Even when startup fails, attempt self-stop. Do not leave paid compute idle.
        request_stop(path, "watchdog_preflight_failed")
    else:
        update_state(path, watchdog={"status": "armed", "pid": os.getpid(),
                                    "heartbeatAt": iso_now(), "selfStopVerified": False})
    while True:
        state = load_state(path)
        expired = clock() >= deadline or monotonic() >= monotonic_deadline
        requested = stop_marker_exists(path, lease, pod_id)
        stopping = expired or requested or bool(state.get("stopRequestedAt"))
        heartbeat = {"status": "stopping" if stopping else "armed", "pid": os.getpid(),
                     "heartbeatAt": iso_now(), "selfStopVerified": False}
        if stopping:
            update_state(path, status="stopping", watchdog=heartbeat,
                         stopReason=state.get("stopReason", "user_requested" if requested else "lease_expired"))
            try:
                if stop_once(pod_id, key, request):
                    heartbeat.update(status="stopped", selfStopVerified=True)
                    update_state(path, status="stopped", watchdog=heartbeat)
                    return 0
            except Exception as error:
                heartbeat["lastStopError"] = safe_error(error)
        update_state(path, watchdog=heartbeat)
        sleep(2 if not stopping else 5)


def child_env(*, allow_hf: bool = False) -> dict:
    env = {k: v for k, v in os.environ.items() if k not in {
        "RUNPOD_API_KEY", "RUNPOD_USER_API_KEY", "HF_TOKEN", "HUGGING_FACE_HUB_TOKEN",
        "HUGGINGFACE_HUB_TOKEN", "HAPPYLATENT_CLOUD_LEASE", "HAPPYLATENT_CLOUD_LOCK_FD",
    }}
    if allow_hf and os.environ.get("HF_TOKEN"):
        env["HF_TOKEN"] = os.environ["HF_TOKEN"]
    env.update(HF_HUB_DISABLE_IMPLICIT_TOKEN="1", HF_HUB_DISABLE_PROGRESS_BARS="1",
               HF_HUB_DISABLE_TELEMETRY="1")
    return env


def renderer_identity(runtime: Path, *, required: bool = True) -> dict | None:
    path = runtime / "render-user.json"
    try:
        with os.fdopen(os.open(path, os.O_RDONLY | os.O_NOFOLLOW | os.O_NONBLOCK), "r") as handle:
            info = os.fstat(handle.fileno())
            if not stat.S_ISREG(info.st_mode) or info.st_uid != os.geteuid() or info.st_mode & 0o077 or info.st_size > 4096:
                raise ValueError("Unsafe render identity record")
            identity = json.load(handle)
    except FileNotFoundError:
        if not required:
            return None
        raise ValueError("Render identity is not configured") from None
    if (set(identity) != {"version", "uid", "gid", "home"} or identity["version"] != 1
            or type(identity["uid"]) is not int or identity["uid"] <= 0
            or type(identity["gid"]) is not int or identity["gid"] <= 0
            or identity["home"] != str(runtime / "render-home")):
        raise ValueError("Invalid render identity")
    return identity


def readonly_tree(root: Path, *, allowed_links: dict | None = None) -> None:
    """The renderer can import approved code, but cannot replace it."""
    if root.is_symlink() or not root.is_dir():
        raise ValueError("Unsafe runtime code tree")
    allowed_links = allowed_links or {}
    for parent, directories, files in os.walk(root, followlinks=False):
        Path(parent).chmod(0o755)
        for name in directories + files:
            path = Path(parent) / name
            if path.is_symlink():
                target = allowed_links.get(path.relative_to(root).as_posix())
                if target is None or path.resolve(strict=True) != Path(target).resolve(strict=True):
                    raise ValueError("Runtime code contains an unapproved symlink")
                continue
            info = path.stat()
            if info.st_uid != os.geteuid():
                raise ValueError("Runtime code must remain supervisor-owned")
            path.chmod(0o755 if path.is_dir() or info.st_mode & 0o111 else 0o644)


def prepare_renderer(runtime: Path, workspace: Path, command, *, lookup=pwd.getpwnam) -> dict:
    if os.geteuid() != 0:
        raise ValueError("Template bootstrap requires root to create an isolated render account")
    name = "happylatent-render"
    home = runtime / "render-home"
    try:
        user = lookup(name)
    except KeyError:
        command(["useradd", "--system", "--user-group", "--no-create-home", "--home-dir", home,
                 "--shell", "/usr/sbin/nologin", name], limit=60)
        user = lookup(name)
    if user.pw_uid <= 0 or user.pw_gid <= 0 or user.pw_dir != str(home) or user.pw_shell != "/usr/sbin/nologin":
        raise ValueError("Existing render account is not the dedicated unprivileged account")
    identity = {"version": 1, "uid": user.pw_uid, "gid": user.pw_gid, "home": str(home)}
    previous = renderer_identity(runtime, required=False)
    if previous and previous != identity:
        raise ValueError("Render identity changed")
    media = media_root(workspace, runtime)
    for directory in (home, runtime / "render-requests", media / "input", media / "output", media / "temp", media / "user"):
        if directory.is_symlink() or (directory.exists() and not directory.is_dir()):
            raise ValueError("Unsafe render data directory")
        directory.mkdir(mode=0o700, parents=True, exist_ok=True)
        if directory.stat().st_uid not in {0, user.pw_uid}:
            raise ValueError("Render data directory belongs to another user")
        os.chown(directory, user.pw_uid, user.pw_gid)
        directory.chmod(0o700)
    readonly_tree(runtime / "ComfyUI", allowed_links={"models": workspace / "models", "input": media / "input", "output": media / "output"})
    readonly_tree(runtime / "venv", allowed_links={
        **{"bin/" + name: Path(sys.executable) for name in ("python", "python3", "python3.12")},
        "lib64": runtime / "venv" / "lib",
    })
    models = workspace / "models"
    if models.is_symlink() or not models.is_dir():
        raise ValueError("Unsafe models directory")
    models.chmod(0o755)
    atomic_json(runtime / "render-user.json", identity)
    # The unprivileged renderer can traverse to code/status, not enumerate root
    # state, leases, credentials or uploaded bundles. Writable data lives apart.
    parents = (workspace, runtime.parent, runtime)
    if media != workspace:
        parents += (runtime.parent.parent, media)
    for directory in parents:
        if directory.is_symlink():
            raise ValueError("Unsafe runtime parent")
        directory.chmod(0o711)
    state = runtime / "state.json"
    if state.is_file() and not state.is_symlink():
        state.chmod(0o644)  # Contains only nonsecret status and approved lease.
    return identity


def tree_digest(root: Path) -> str:
    """Match cloud_prepare's POSIX path/NUL/content/NUL digest; reject links."""
    digest = hashlib.sha256()
    total = 0
    def visit(directory):
        nonlocal total
        for entry in sorted(directory.iterdir(), key=lambda p: p.name):
            if entry.is_symlink():
                raise ValueError("Setup bundle must not contain symlinks")
            if entry.is_dir():
                visit(entry)
            elif entry.is_file():
                total += entry.stat().st_size
                if total > 64 * 1024 * 1024:
                    raise ValueError("Setup source bundle is too large")
                digest.update(entry.relative_to(root).as_posix().encode())
                digest.update(b"\0")
                with entry.open("rb") as handle:
                    for chunk in iter(lambda: handle.read(1024 * 1024), b""):
                        digest.update(chunk)
                digest.update(b"\0")
            else:
                raise ValueError("Setup bundle contains a nonregular file")
    if root.is_symlink() or not root.is_dir():
        raise ValueError("Invalid setup bundle")
    visit(root)
    return digest.hexdigest()


def read_setup(bundle: Path, *, verify_name: bool = True) -> dict:
    if verify_name and (not re.fullmatch(r"[0-9a-f]{64}", bundle.name) or tree_digest(bundle) != bundle.name):
        raise ValueError("Uploaded setup bundle failed integrity verification")
    path = bundle / "setup.json"
    if path.is_symlink() or path.stat().st_size > 65536:
        raise ValueError("Invalid setup manifest")
    setup = json.loads(path.read_text())
    fields = {"version", "media", "templateId", "image", "comfyRevision", "approvalPublicKey", "dependencyLockSha256", "requirementsSha256"}
    if (isinstance(setup, dict) and setup.get("version") == 6
            and setup.get("spatialUpscale") is True and setup.get("media") in ("video", "both", "all")):
        fields.add("spatialUpscale")
    if isinstance(setup, dict) and setup.get("launchTelemetry") is True:
        fields.add("launchTelemetry")
    if (not isinstance(setup, dict) or set(setup) != fields or (setup.get("version") == 6 and "spatialUpscale" not in fields)
            or setup["version"] not in {3, 4, 5, 6} or setup["media"] not in {"image", "video", "both", "music", "all"}
            or not isinstance(setup["templateId"], str) or not re.fullmatch(r"[A-Za-z0-9_-]{1,128}", setup["templateId"])
            or not isinstance(setup["image"], str) or not re.fullmatch(r"runpod/pytorch@sha256:[0-9a-f]{64}", setup["image"])
            or not isinstance(setup["comfyRevision"], str) or not re.fullmatch(r"[0-9a-f]{40}", setup["comfyRevision"])
            or any(not isinstance(setup[key], str) or not re.fullmatch(r"[a-f0-9]{64}", setup[key]) for key in ("dependencyLockSha256", "requirementsSha256"))):
        raise ValueError("Invalid setup manifest")
    approval_public_key(setup["approvalPublicKey"])
    dependency_lock = bundle / "cloud" / "runtime-requirements.txt"
    if dependency_lock.is_symlink() or dependency_lock.stat().st_size > 1024 * 1024 or hashlib.sha256(dependency_lock.read_bytes()).hexdigest() != setup["dependencyLockSha256"]:
        raise ValueError("Runtime dependency lock failed integrity verification")
    if not (bundle / "node").is_dir() or not (bundle / "models.json").is_file():
        raise ValueError("Incomplete setup bundle")
    return setup


def approval_public_key(value: str) -> bytes:
    if not isinstance(value, str) or len(value) > 256:
        raise ValueError("Invalid approval public key")
    match = re.fullmatch(r"-----BEGIN PUBLIC KEY-----\n([A-Za-z0-9+/=\n]+)-----END PUBLIC KEY-----\n?", value)
    if not match:
        raise ValueError("Invalid approval public key")
    der = base64.b64decode(match[1].replace("\n", ""), validate=True)
    if len(der) != 44 or der[:12] != bytes.fromhex("302a300506032b6570032100"):
        raise ValueError("Approval key must be Ed25519")
    return value.encode("ascii")


def verify_download_approval(lease: dict, setup: dict, models: list, *, destination: Path = WORKSPACE / "models",
                             installation: dict | None = None, clock=time.time, run=subprocess.run,
                             openssl="/usr/bin/openssl") -> dict:
    """Verify only the receipt signed after client approval by the local server."""
    try:
        receipt = lease["downloadApproval"]
        if not isinstance(receipt, dict) or set(receipt) != {"payload", "signature"}:
            raise ValueError()
        if len(receipt["payload"]) > 65536 or len(receipt["signature"]) > 128:
            raise ValueError()
        payload = base64.b64decode(receipt["payload"], validate=True)
        signature = base64.b64decode(receipt["signature"], validate=True)
        approved = json.loads(payload)
        fields = {"version", "purpose", "runtimeId", "bundleId", "destination", "models", "issuedAt", "expiresAt"}
        if lease.get("networkVolumeId"):
            fields.add("networkVolumeId")
        if lease.get("containerDiskGb"):
            fields.add("containerDiskGb")
        if installation is not None:
            fields.add("installation")
        if (len(signature) != 64 or not isinstance(approved, dict)
                or set(approved) != fields or approved.get("networkVolumeId") != lease.get("networkVolumeId")
                or approved.get("containerDiskGb") != lease.get("containerDiskGb")
                or approved["version"] != 1 or approved.get("installation") != installation
                or approved["purpose"] != ("model-install" if installation is not None else "model-download")
                or approved["runtimeId"] != lease["runtimeId"] or approved["bundleId"] != lease["bundleId"]
                or approved["destination"] != str(destination) or approved["models"] != models
                or approved["expiresAt"] != lease["deadline"]
                or timestamp(approved["issuedAt"]) > clock() + 30
                or timestamp(approved["issuedAt"]) < timestamp(lease["createdAt"]) - 30
                or timestamp(approved["expiresAt"]) <= clock()):
            raise ValueError()
        key = approval_public_key(setup["approvalPublicKey"])
        with tempfile.TemporaryDirectory(prefix="happylatent-approval-") as directory:
            root = Path(directory)
            for name, content in (("public.pem", key), ("payload", payload), ("signature", signature)):
                with os.fdopen(os.open(root / name, os.O_WRONLY | os.O_CREAT | os.O_EXCL, 0o600), "wb") as handle:
                    handle.write(content)
            run([openssl, "pkeyutl", "-verify", "-pubin", "-inkey", str(root / "public.pem"),
                 "-rawin", "-in", str(root / "payload"), "-sigfile", str(root / "signature")],
                check=True, timeout=10, stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL,
                env={"PATH": "/usr/bin:/bin"})
        return approved
    except (KeyError, TypeError, ValueError, OSError, subprocess.SubprocessError):
        raise ValueError("An unexpired signed approval for these exact model downloads is required") from None


def setup_template(bundle: Path = BUNDLE_ROOT, runtime: Path = RUNTIME_ROOT, *,
                   run=subprocess.run, clock=time.time) -> None:
    """Install only inside an owned runtime; caller has already armed watchdog."""
    setup = read_setup(bundle)
    owner = json.loads((runtime / "owner.json").read_text())
    lease = owner["lease"]
    if owner.get("bundleId") != bundle.name or lease.get("bundleId") != bundle.name or lease["media"] != setup["media"]:
        raise ValueError("Setup bundle does not match the runtime lease")
    deadline = timestamp(lease["deadline"])
    env = child_env()
    env.update(GIT_CONFIG_NOSYSTEM="1", GIT_CONFIG_GLOBAL="/dev/null", GIT_TERMINAL_PROMPT="0",
               PIP_CONFIG_FILE="/dev/null", DEBIAN_FRONTEND="noninteractive")
    def command(args, *, cwd=None, limit=600):
        remaining = deadline - clock()
        if remaining <= 0:
            raise TimeoutError("Setup lease expired")
        timeout = remaining if limit is None else min(limit, remaining)
        return run([str(x) for x in args], cwd=cwd, env=env, check=True,
                   timeout=timeout, capture_output=True, text=True)
    # Read the template's GPU stack before installing anything. A system-site
    # venv reuses it; constraints prevent pip from replacing CUDA torch packages.
    inspect_stack = ("import sys,json,importlib.metadata as m,torch; "
                     "assert sys.version_info[:2] == (3,12), 'Dependency lock requires Python 3.12'; "
                     "assert torch.version.cuda and torch.cuda.is_available(), 'Usable CUDA PyTorch required'; "
                     "print(json.dumps({n:m.version(n) for n in ('torch','torchvision','torchaudio')}))")
    stack = json.loads(command([sys.executable, "-I", "-c", inspect_stack], limit=60).stdout)
    if set(stack) != {"torch", "torchvision", "torchaudio"} or any(not re.fullmatch(r"[A-Za-z0-9.+_-]+", v) for v in stack.values()):
        raise ValueError("Invalid template PyTorch metadata")
    apt = ["apt-get", "-o", "Acquire::AllowInsecureRepositories=false", "-o", "APT::Get::AllowUnauthenticated=false"]
    command([*apt, "update"], limit=300)
    command([*apt, "install", "-y", "--no-install-recommends", "ca-certificates", "git",
             "ffmpeg", "libgl1", "libglib2.0-0"], limit=600)
    comfy = runtime / "ComfyUI"
    git = ["git", "-c", "core.fsmonitor=false", "-c", "core.hooksPath=/dev/null"]
    if comfy.exists():
        if comfy.is_symlink() or not (comfy / ".git").is_dir() or (comfy / ".git").is_symlink():
            raise ValueError("Refusing to replace an existing ComfyUI source tree")
        revision = command([*git, "rev-parse", "HEAD"], cwd=comfy).stdout.strip()
        if revision != setup["comfyRevision"]:
            raise ValueError("Existing ComfyUI revision differs from the approved source")
        # Storage directories are deliberately moved to the dedicated volume.
        changes = command([*git, "status", "--porcelain", "--untracked-files=all", "--", ".",
                           ":(exclude)models", ":(exclude)input", ":(exclude)output",
                           ":(exclude)models.image-default", ":(exclude)input.image-default",
                           ":(exclude)output.image-default", ":(exclude)custom_nodes/happylatent"], cwd=comfy).stdout
        if changes.strip():
            raise ValueError("Existing ComfyUI source has unapproved changes")
    else:
        comfy.mkdir(mode=0o700)
        command([*git, "init", str(comfy)])
        command([*git, "fetch", "--depth", "1", "https://github.com/Comfy-Org/ComfyUI.git", setup["comfyRevision"]], cwd=comfy)
        command([*git, "checkout", "--detach", "FETCH_HEAD"], cwd=comfy)
        if command([*git, "rev-parse", "HEAD"], cwd=comfy).stdout.strip() != setup["comfyRevision"]:
            raise ValueError("Fetched ComfyUI revision did not match")
    node = comfy / "custom_nodes" / "happylatent"
    if hashlib.sha256((comfy / "requirements.txt").read_bytes()).hexdigest() != setup["requirementsSha256"]:
        raise ValueError("ComfyUI requirements differ from the reviewed dependency lock")
    if node.exists():
        if tree_digest(node) != tree_digest(bundle / "node"):
            raise ValueError("Existing Happy Latent source differs from uploaded bundle")
    else:
        shutil.copytree(bundle / "node", node)
    venv = runtime / "venv"
    if venv.is_symlink():
        raise ValueError("Runtime environment must not be a symlink")
    if not venv.exists():
        command([sys.executable, "-I", "-m", "venv", "--system-site-packages", str(venv)])
    elif not (venv / "pyvenv.cfg").is_file() or "include-system-site-packages = true" not in (venv / "pyvenv.cfg").read_text():
        raise ValueError("Existing runtime does not reuse the approved template environment")
    python = venv / "bin" / "python"
    constraints = runtime / "torch-constraints.txt"
    constraints.write_text("".join(name + "==" + version + "\n" for name, version in sorted(stack.items())))
    constraints.chmod(0o600)
    # Downloads can outlast the ordinary command limit on slow Pod connections.
    command([python, "-I", "-m", "pip", "--isolated", "install", "--no-input", "--disable-pip-version-check",
             "--index-url", "https://pypi.org/simple", "--require-hashes", "--only-binary=:all:", "--no-deps",
             "-c", constraints, "-r", bundle / "cloud" / "runtime-requirements.txt"], limit=None)
    command([python, "-I", "-m", "pip", "--isolated", "check"])
    if json.loads(command([python, "-I", "-c", inspect_stack], limit=60).stdout) != stack:
        raise ValueError("Setup changed the template PyTorch stack")
    prepare_storage(WORKSPACE, comfy, media=media_root(WORKSPACE, runtime))
    atomic_json(runtime / "setup-complete.json", {"bundleId": bundle.name, "comfyRevision": setup["comfyRevision"], "torch": stack})
    prepare_renderer(runtime, WORKSPACE, command)


def model_destination(root: Path, item: dict) -> Path:
    if not re.fullmatch(r"[A-Za-z0-9_.-]+/[A-Za-z0-9_.-]+", item.get("repo", "")):
        raise ValueError("Invalid model repository")
    if not re.fullmatch(r"[0-9a-f]{40}", item.get("revision", "")):
        raise ValueError("Models must be pinned to a commit")
    if not re.fullmatch(r"[0-9a-f]{64}", item.get("sha256", "")):
        raise ValueError("Models require a SHA-256 digest")
    if type(item.get("size")) is not int or item["size"] <= 0:
        raise ValueError("Invalid model size")
    path = PurePosixPath(item.get("path", ""))
    if path.is_absolute() or not path.parts or any(x in {".", ".."} for x in path.parts) or "\\" in str(path):
        raise ValueError("Invalid model path")
    filename = PurePosixPath(item.get("filename", item.get("path", "")))
    if filename.is_absolute() or not filename.parts or ".." in filename.parts or "\\" in str(filename):
        raise ValueError("Invalid model filename")
    destination = root.joinpath(*path.parts)
    if any(p.is_symlink() for p in [root, destination, *destination.parents] if p != root.parent):
        raise ValueError("Model paths must not contain symlinks")
    return destination


def verify_model(path: Path, item: dict) -> bool:
    if not path.is_file() or path.is_symlink() or path.stat().st_uid != os.geteuid() or path.stat().st_size != item["size"]:
        return False
    digest = hashlib.sha256()
    with path.open("rb") as handle:
        for chunk in iter(lambda: handle.read(8 * 1024 * 1024), b""):
            digest.update(chunk)
    return digest.hexdigest() == item["sha256"]


def require_model_approval(items: list, root: Path, *, bundle: Path = BUNDLE_ROOT,
                           runtime: Path = RUNTIME_ROOT, clock=time.time) -> None:
    setup = read_setup(bundle)
    owner = json.loads((runtime / "owner.json").read_text())
    lease = owner["lease"]
    if owner.get("bundleId") != bundle.name or lease.get("bundleId") != bundle.name:
        raise ValueError("Model approval belongs to another runtime bundle")
    verify_download_approval(lease, setup, items, destination=root, clock=clock)


def download_models(manifest: Path = MANIFEST, root: Path = WORKSPACE / "models") -> dict:
    items = json.loads(manifest.read_text())
    if not isinstance(items, list) or not items:
        raise ValueError("Empty model manifest")
    require_model_approval(items, root)
    cached = install_models(items, root)
    return {"verified": [item["sha256"] for item in items], "cached": cached}


def install_models(items: list, root: Path, *, require_active=lambda: None) -> list[str]:
    from huggingface_hub import hf_hub_download
    root.mkdir(parents=True, exist_ok=True)
    root.chmod(0o755)
    destinations = [(item, model_destination(root, item)) for item in items]
    if len({str(path) for _, path in destinations}) != len(destinations):
        raise ValueError("Duplicate model destination")
    missing = []
    cached = []
    for item, destination in destinations:
        if verify_model(destination, item):
            destination.chmod(0o644)
            cached.append(item["sha256"])
        elif destination.exists():
            raise ExistingModelConflict()
        else:
            missing.append((item, destination))
    # Reserve room for runtime state and outputs. Existing verified models are
    # excluded. Partial HF cache files are conservatively treated as full files;
    # no cache or model file is removed to make space.
    if missing:
        require_download_space(root, sum(item["size"] for item, _ in missing))
    for item, destination in missing:
        require_active()
        destination.parent.mkdir(parents=True, exist_ok=True)
        for directory in [destination.parent, *destination.parent.parents]:
            if directory == root.parent:
                break
            if directory.stat().st_uid != os.geteuid():
                raise ValueError("Model directories must remain supervisor-owned")
            directory.chmod(0o755)
        if destination.exists():
            raise ExistingModelConflict()
        require_download_space(root, item["size"])
        # The HF filename and ComfyUI destination can differ. Download into HF's
        # managed cache, validate it, then atomically link to the chosen category.
        downloaded = Path(hf_hub_download(repo_id=item["repo"], filename=item.get("filename", item["path"]),
                          revision=item["revision"], cache_dir=root.parent / ".happylatent-cloud" / "hf-cache",
                          token=os.environ.get("HF_TOKEN") or False))
        # HF's cache deliberately uses symlinks to content-addressed blobs.
        source = downloaded.resolve(strict=True)
        if not verify_model(source, item):
            raise ValueError("Downloaded model failed integrity verification")
        require_active()
        try:
            # Cache and models share /workspace. A hardlink avoids storing these
            # large immutable weights twice and preserves resumable HF downloads.
            # Creating the final link also refuses a concurrent existing file.
            source.chmod(0o644)
            os.link(source, destination)
        except FileExistsError:
            raise ExistingModelConflict() from None
    return cached


def model_install_path(runtime: Path, install_id: str) -> Path:
    if not re.fullmatch(r"[a-f0-9]{64}", install_id):
        raise ValueError("Invalid model installation ID")
    return runtime / "model-installs" / (install_id + ".json")


def require_model_install_active(state: dict, path: Path) -> None:
    lease = state["lease"]
    watchdog = state.get("watchdog", {})
    now = time.time()
    if (state["status"] != "ready" or now >= timestamp(lease["deadline"])
            or state.get("stopRequestedAt") or stop_marker_exists(path, lease, state["podId"])
            or watchdog.get("status") not in {"armed", "running"}
            or abs(now - timestamp(watchdog["heartbeatAt"])) > 30):
        raise ValueError("Model installation requires a ready runtime with an active lease and healthy watchdog")


def missing_install_models(items: list, root: Path) -> list:
    if not isinstance(items, list) or not 1 <= len(items) <= 16:
        raise ValueError("Invalid model installation list")
    missing = []
    seen = set()
    for item in items:
        destination = model_destination(root, item)
        if destination in seen:
            raise ValueError("Duplicate model destination")
        seen.add(destination)
        if not destination.exists():
            missing.append(item)
        elif (not destination.is_file() or destination.stat().st_uid != os.geteuid()
                or destination.stat().st_size != item["size"]):
            raise ExistingModelConflict()
    return missing


def public_install(record: dict) -> dict:
    return {key: record[key] for key in ("installId", "status", "files", "totalBytes", "error") if key in record}


def model_install_request(request: dict, *, root: Path = WORKSPACE) -> dict:
    """Fixed operations exposed only through the pinned administrative SSH connection."""
    identity = request["identity"]
    if str(uuid.UUID(identity["runtimeId"])) != identity["runtimeId"]:
        raise ValueError("Invalid model installation runtime ID")
    path = runtime_root(root, identity) / "state.json"
    state = load_state(path)
    lease = state["lease"]
    if (state.get("modelInstallVersion") != 1 or state["runtimeId"] != identity["runtimeId"]
            or state["podId"] != identity["podId"] or lease["bundleId"] != identity["bundleId"]
            or lease["deadline"] != identity["deadline"] or lease.get("networkVolumeId") != identity.get("networkVolumeId")):
        raise ValueError("Model installation runtime identity mismatch")
    operation = request["operation"]
    directory = path.parent / "model-installs"
    if operation == "active":
        active = any(load_state(record)["status"] in {"queued", "running"} for record in directory.glob("*.json"))
        return {"status": "active" if active else "idle"}
    install_id = request["installId"]
    target = model_install_path(path.parent, install_id)
    if operation == "status":
        return public_install(load_state(target)) if target.exists() else {"installId": install_id, "status": "unknown"}
    if operation not in {"preview", "enqueue"}:
        raise ValueError("Invalid model installation operation")
    require_model_install_active(state, path)
    private_directory(target.parent)
    lock = os.open(target.parent / ".requests.lock", os.O_CREAT | os.O_RDWR | os.O_NOFOLLOW, 0o600)
    with os.fdopen(lock, "r+") as handle:
        fcntl.flock(handle, fcntl.LOCK_EX)
        candidates = request["models"]
        if target.exists():
            prior = load_state(target)
            if prior["candidates"] != candidates:
                raise ValueError("This request ID is already bound to another model selection")
            return public_install(prior)
        if any(load_state(record)["status"] in {"queued", "running"} for record in target.parent.glob("*.json")):
            raise ValueError("Another model installation is active on this Pod")
        models = missing_install_models(candidates, root / "models")
        total = sum(model["size"] for model in models)
        view = {"installId": install_id, "status": "review" if models else "already_ready",
                "files": [model["path"] for model in models], "totalBytes": total}
        if models:
            require_download_space(root / "models", total)
        if operation == "preview":
            return view
        if view["files"] != request["files"]:
            raise ValueError("Missing models changed during review. Retry to review the current file list")
        if not models:
            return view
        installation = {"installId": install_id, "podId": state["podId"]}
        bundle = root / ".happylatent-cloud" / "bundles" / lease["bundleId"]
        verify_download_approval({**lease, "downloadApproval": request["approval"]}, read_setup(bundle), models,
                                 destination=root / "models", installation=installation)
        require_model_install_active(load_state(path), path)
        record = {**view, "status": "queued", "candidates": candidates, "models": models,
                  "approval": request["approval"]}
        atomic_json(target, record)
        return public_install(record)


def run_model_install(install_id: str) -> None:
    path = RUNTIME_ROOT / "state.json"
    state = load_state(path)
    lease = state["lease"]
    target = model_install_path(RUNTIME_ROOT, install_id)
    record = load_state(target)
    if record["status"] != "running" or lease["bundleId"] != BUNDLE_ROOT.name:
        raise ValueError("Model installation is not running on this runtime")

    def require_active():
        current = load_state(path)
        if current["runtimeId"] != state["runtimeId"] or current["podId"] != state["podId"]:
            raise ValueError("Model installation runtime changed")
        require_model_install_active(current, path)

    require_active()
    models_root = WORKSPACE / "models"
    verify_download_approval({**lease, "downloadApproval": record["approval"]}, read_setup(BUNDLE_ROOT),
                             record["models"], destination=models_root,
                             installation={"installId": install_id, "podId": state["podId"]})
    install_models(record["models"], models_root, require_active=require_active)


def require_download_space(root: Path, required_bytes: int) -> None:
    free = shutil.disk_usage(root).free
    if free < required_bytes + 2_000_000_000:
        raise InsufficientStorage(
            f"Insufficient cloud storage: {free / 1e9:.1f} GB free; "
            f"missing models need {required_bytes / 1e9:.1f} GB plus 2 GB reserve. "
            "Increase the volume with spending approval or review retrieved-media cleanup before retrying. "
            "No model or cache files were deleted.")


def prepare_storage(root: Path = WORKSPACE, comfy: Path = COMFY_ROOT, *, media: Path | None = None) -> None:
    media = root if media is None else media
    if media.is_symlink():
        raise ValueError("Unsafe session media directory")
    for name, destination in (("models", root / "models"), ("input", media / "input"), ("output", media / "output")):
        if destination.is_symlink():
            raise ValueError("Unsafe session storage directory")
        destination.mkdir(parents=True, exist_ok=True)
        target = comfy / name
        if target.is_symlink():
            if target.resolve() != destination.resolve():
                raise ValueError("Unexpected ComfyUI storage link")
            continue
        if target.exists():
            # Preserve only the image's bundled placeholders/example assets.
            target.rename(comfy / (name + ".image-default"))
        target.symlink_to(destination, target_is_directory=True)


def kill_process(process) -> None:
    if process is not None and process.poll() is None:
        with contextlib.suppress(ProcessLookupError):
            os.killpg(process.pid, signal.SIGTERM)
        try:
            process.wait(timeout=5)
        except subprocess.TimeoutExpired:
            with contextlib.suppress(ProcessLookupError):
                os.killpg(process.pid, signal.SIGKILL)


def no_new_privileges() -> None:
    # No shell or thread is running in this child. Prevent setuid/file-capability
    # privilege gains from any subprocess the rendering code later launches.
    libc = ctypes.CDLL(None, use_errno=True)
    if libc.prctl(38, 1, 0, 0, 0) != 0:  # Linux PR_SET_NO_NEW_PRIVS
        raise OSError(ctypes.get_errno(), "Could not restrict renderer privileges")


def advance_model_install(runtime: Path, active, *, popen, python: Path):
    if active is not None:
        target, record, process = active
        code = process.poll()
        if code is None:
            return active
        if code == 0:
            atomic_json(target, {**record, "status": "completed"})
        else:
            atomic_json(target, {**record, "status": "failed",
                                "error": "Model download or verification failed. Check storage and Hugging Face access before retrying."})
        return None

    for target in (runtime / "model-installs").glob("*.json"):
        record = load_state(target)
        if record["status"] == "running":
            atomic_json(target, {**record, "status": "failed", "error": "The model installation was interrupted."})
        elif record["status"] == "queued":
            record["status"] = "running"
            atomic_json(target, record)
            try:
                process = popen(worker_command(python, Path(__file__).resolve(), "--install-models", record["installId"]),
                                env=child_env(allow_hf=True), start_new_session=True)
            except OSError:
                atomic_json(target, {**record, "status": "failed", "error": "Could not start the model downloader."})
                return None
            return target, record, process
    return None


def supervise(lease: dict, path: Path, pod_id: str, key: str, *,
              popen=subprocess.Popen, clock=time.time, sleep=time.sleep,
              runtime: Path = RUNTIME_ROOT) -> int:
    watchdog = None
    children = []
    model_install = None

    def require_active() -> None:
        state = load_state(path)
        guard = state.get("watchdog", {})
        if (clock() >= timestamp(lease["deadline"]) or state.get("status") in {"stopping", "stopped", "failed"}
                or state.get("stopRequestedAt") or stop_marker_exists(path, lease, pod_id)):
            raise RuntimeError("Lease is no longer active")
        if watchdog is None or watchdog.poll() is not None:
            raise RuntimeError("Watchdog exited unexpectedly")
        try:
            heartbeat = timestamp(guard["heartbeatAt"])
        except (KeyError, TypeError, ValueError, AttributeError):
            heartbeat = float("-inf")
        if abs(clock() - heartbeat) > 30:
            kill_process(watchdog)
            raise RuntimeError("Watchdog heartbeat is stale")
        if guard.get("status") not in {"armed", "running"}:
            raise RuntimeError("Watchdog is not armed")

    try:
        if not pod_id or not key:
            raise ValueError("Injected pod credentials are unavailable")
        watchdog_env = child_env()
        watchdog_env.update(RUNPOD_API_KEY=key, RUNPOD_POD_ID=pod_id,
                            HAPPYLATENT_CLOUD_LEASE=base64.b64encode(json.dumps(lease).encode()).decode(),
                            HAPPYLATENT_CLOUD_STATE=str(path))
        watchdog = popen(worker_command(sys.executable, Path(__file__).resolve(), "--watchdog"),
                         env=watchdog_env, start_new_session=True)
        # Native SSH is already running. Do not install dependencies, clone code,
        # or download models until this independent watchdog has been armed.
        for _ in range(100):
            state = load_state(path)
            if state.get("watchdog", {}).get("status") == "armed":
                break
            if watchdog.poll() is not None or state.get("status") in {"stopped", "failed", "stopping"}:
                raise RuntimeError("Watchdog could not be armed")
            sleep(0.1)
        else:
            raise RuntimeError("Watchdog startup timed out")
        if timestamp(lease["createdAt"]) > clock() + 30:
            raise RuntimeError("Lease creation time is in the future")
        require_active()
        update_state(path, stage="watchdog_armed")
        update_state(path, status="installing", stage="installing")
        install = popen(worker_command(sys.executable, Path(__file__).resolve(), "--setup"),
                        env=child_env(), start_new_session=True)
        children.append(install)
        download = comfy = None
        python = runtime / "venv" / "bin" / "python"
        comfy_root = runtime / "ComfyUI"
        media = media_root(WORKSPACE, runtime)
        while True:
            state = load_state(path)
            if state.get("status") in {"stopping", "stopped"} or clock() >= timestamp(lease["deadline"]):
                break
            require_active()
            if download is None and install.poll() is not None:
                if install.returncode != 0:
                    raise RuntimeError("Template dependency setup failed")
                require_active()
                update_state(path, status="downloading", stage="downloading")
                download = popen(worker_command(python, Path(__file__).resolve(), "--download"),
                                 env=child_env(allow_hf=True), start_new_session=True)
                children.append(download)
            if download is not None and comfy is None and download.poll() is not None:
                if download.returncode != 0:
                    raise RuntimeError("Model setup failed")
                require_active()
                try:
                    models = json.loads((runtime / "verified-models.json").read_text())
                except FileNotFoundError:
                    models = {}
                update_state(path, verifiedModels=models.get("verified"), cachedModels=models.get("cached"))
                identity = renderer_identity(runtime)
                env = child_env()
                env.update(HF_HUB_OFFLINE="1", TRANSFORMERS_OFFLINE="1", HOME=identity["home"],
                           XDG_CACHE_HOME=str(Path(identity["home"]) / ".cache"),
                           HF_HOME=str(Path(identity["home"]) / ".cache" / "huggingface"),
                           HAPPYLATENT_CLOUD_STOP_DIR=str(runtime / "render-requests"))
                comfy = popen([str(python), "-B", str(comfy_root / "main.py"),
                    "--listen", "127.0.0.1", "--port", "8188", "--disable-auto-launch", "--offline",
                    "--input-directory", str(media / "input"), "--output-directory", str(media / "output"),
                    "--temp-directory", str(media / "temp"), "--user-directory", str(media / "user"),
                    "--disable-all-custom-nodes", "--whitelist-custom-nodes", "happylatent"],
                    cwd=comfy_root, env=env, start_new_session=True, user=identity["uid"], group=identity["gid"],
                    extra_groups=(), umask=0o077, preexec_fn=no_new_privileges)
                children.append(comfy)
                update_state(path, status="starting", stage="starting")
            if comfy is not None and comfy.poll() is not None:
                raise RuntimeError("ComfyUI exited")
            if comfy is not None and state.get("status") == "starting":
                try:
                    with urllib.request.build_opener(urllib.request.ProxyHandler({}), NoRedirect()).open("http://127.0.0.1:8188/system_stats", timeout=1) as response:
                        if response.status == 200:
                            update_state(path, status="ready", stage="ready")
                except (OSError, urllib.error.URLError):
                    pass
            if state.get("status") == "ready":
                model_install = advance_model_install(runtime, model_install, popen=popen, python=python)
            sleep(1)
    except Exception as error:
        update_state(path, error="startup_or_runtime_" + safe_error(error))
    finally:
        if load_state(path).get("status") != "stopped":
            request_stop(path, load_state(path).get("stopReason", "runtime_finished"))
        if model_install is not None:
            kill_process(model_install[2])
        for process in reversed(children):
            kill_process(process)
    # Exiting this process does not stop a template Pod. Preserve the watchdog
    # while it retries and take over if it fails, including during wait().
    if not pod_id or not key:
        update_state(path, status="failed", error="pod_credentials_missing")
        return 1
    if watchdog is None or watchdog.poll() is not None:
        return watchdog_loop(lease, path, pod_id, key)
    result = watchdog.wait()
    return watchdog_loop(lease, path, pod_id, key) if result != 0 else result


def main() -> int:
    os.umask(0o077)
    if len(sys.argv) == 3 and sys.argv[1] == "--install-models":
        try:
            run_model_install(sys.argv[2])
            return 0
        except Exception as error:
            print("Model installation failed: " + safe_error(error), flush=True)
            return 1
    if sys.argv[1:] in (["--download"], ["--setup"]):
        try:
            if sys.argv[1:] == ["--setup"]:
                setup_template()
            else:
                atomic_json(RUNTIME_ROOT / "verified-models.json", download_models())
            return 0
        except Exception as error:
            print("Runtime setup failed: " + safe_error(error), flush=True)
            return 1
    path = Path(os.environ.get("HAPPYLATENT_CLOUD_STATE", STATE_PATH))
    lease = read_lease(os.environ.get("HAPPYLATENT_CLOUD_LEASE", ""))
    pod_id = os.environ.get("RUNPOD_POD_ID", "")
    key = os.environ.get("RUNPOD_API_KEY", "")
    if sys.argv[1:] == ["--watchdog"]:
        return watchdog_loop(lease, path, pod_id, key)
    if path != runtime_root(WORKSPACE, lease) / "state.json" or BUNDLE_ROOT.parent != WORKSPACE / ".happylatent-cloud" / "bundles":
        raise ValueError("Invalid managed runtime path")
    lock_fd = int(os.environ.get("HAPPYLATENT_CLOUD_LOCK_FD", "-1"))
    held = os.fstat(lock_fd)
    expected = (RUNTIME_ROOT / "worker.lock").stat()
    if (held.st_dev, held.st_ino) != (expected.st_dev, expected.st_ino):
        raise ValueError("Worker must be launched by the guarded bootstrap")
    read_setup(BUNDLE_ROOT)
    persist_lease(lease)
    atomic_json(path, {"version": 1, "runtimeId": lease["runtimeId"], "podId": pod_id,
                       "lease": lease, "status": "booting", "watchdog": {"status": "unarmed"},
                       "modelInstallVersion": 1})
    for sig in (signal.SIGTERM, signal.SIGINT):
        signal.signal(sig, lambda signum, frame: request_stop(path, "signal"))
    return supervise(lease, path, pod_id, key)


def emergency_stop(path: Path, *, request=pod_request, sleep=time.sleep) -> int:
    """Malformed leases/setup must not leave a paid pod running without a guard."""
    pod_id, key = os.environ.get("RUNPOD_POD_ID", ""), os.environ.get("RUNPOD_API_KEY", "")
    if not key or not pod_id:
        return 1
    while True:
        try:
            if stop_once(pod_id, key, request):
                return 0
        except Exception as error:
            print("Emergency self-stop retry: " + safe_error(error), flush=True)
        sleep(5)


if __name__ == "__main__":
    try:
        sys.exit(main())
    except Exception as error:
        print("Cloud worker failed: " + safe_error(error), flush=True)
        sys.exit(emergency_stop(Path(os.environ.get("HAPPYLATENT_CLOUD_STATE", STATE_PATH))))
