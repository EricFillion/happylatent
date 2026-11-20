#!/usr/bin/env python3
"""Start a guarded Happy Latent runtime on an official Runpod PyTorch Pod.

Invoke through authenticated provider exec after uploading the complete bundle.
Only this bootstrap reads the native template's provider environment; secrets
are never included in replies, arguments, state files, or child setup logs.
"""
from __future__ import annotations

import contextlib
import fcntl
import importlib.util
import json
import os
from pathlib import Path
import re
import stat
import subprocess
import sys
import tempfile
import time

# Avoid creating __pycache__ inside the content-addressed uploaded source tree.
sys.dont_write_bytecode = True
SPEC = importlib.util.spec_from_file_location("happylatent_cloud_worker", Path(__file__).with_name("worker.py"))
worker = importlib.util.module_from_spec(SPEC)
SPEC.loader.exec_module(worker)

RECOVER_KEYS = {"RUNPOD_API_KEY", "RUNPOD_POD_ID", "HAPPYLATENT_CLOUD_LEASE", "HF_TOKEN"}
SECRET_KEYS = RECOVER_KEYS | {"RUNPOD_USER_API_KEY", "HUGGING_FACE_HUB_TOKEN", "HUGGINGFACE_HUB_TOKEN"}


class UnsupportedStoragePermissions(ValueError):
    """The workspace cannot isolate supervisor files from the renderer."""


class MissingNetworkVolume(ValueError):
    """The planned shared workspace was not mounted."""


class UnexpectedWorkspaceMount(ValueError):
    """A container-disk session has a separate workspace mount."""


def require_private_storage(workspace: Path) -> None:
    # Some Runpod FUSE volumes report chmod success but leave files 0666 and
    # directories 0777. Reject these before reading credentials or installing.
    if workspace.is_symlink() or not workspace.is_dir():
        raise ValueError("Workspace must be a real directory")
    with tempfile.TemporaryDirectory(prefix=".happylatent-permissions-", dir=workspace) as temporary:
        directory = Path(temporary)
        directory.chmod(0o700)
        probe = directory / "probe"
        probe.write_bytes(b"")
        probe.chmod(0o600)
        for path, mode in ((directory, 0o700), (probe, 0o600)):
            info = path.stat()
            if info.st_uid != os.geteuid() or stat.S_IMODE(info.st_mode) != mode:
                raise UnsupportedStoragePermissions("Workspace must enforce POSIX ownership and permissions")
        try:
            os.link(probe, directory / "link")
        except OSError:
            raise UnsupportedStoragePermissions("Workspace must support hardlinks for the model cache") from None


def recovered_environment(environ: dict, proc_environ: Path = Path("/proc/1/environ")) -> dict:
    """Recover only explicit launch fields, never arbitrary PID 1 environment."""
    selected = {key: environ[key] for key in RECOVER_KEYS if environ.get(key)}
    missing = RECOVER_KEYS - selected.keys()
    if missing:
        with proc_environ.open("rb") as handle:
            content = handle.read(1024 * 1024 + 1)
        if len(content) > 1024 * 1024:
            raise ValueError("Template environment exceeded safety limit")
        for field in content.split(b"\0"):
            name, separator, value = field.partition(b"=")
            if separator:
                key = name.decode("ascii", errors="ignore")
                if key in missing:
                    selected[key] = value.decode("utf-8")
    if any(not isinstance(value, str) or len(value) > 65536 or any(c in value for c in "\r\n\0") for value in selected.values()):
        raise ValueError("Invalid template runtime environment")
    if not selected.get("RUNPOD_API_KEY") or not re.fullmatch(r"[A-Za-z0-9_-]{3,128}", selected.get("RUNPOD_POD_ID", "")):
        raise ValueError("Provider-injected Pod credentials are missing")
    return selected


def sanitize_template_environment(path: Path = Path("/etc/rp_environment"), *, expected: dict | None = None) -> None:
    """The native PyTorch start script exports credentials here before bootstrap.

    Keep only non-sensitive assignments and make the template-owned file private.
    Do not read shell startup files or follow links. A missing file means the
    native entrypoint has not finished export_env_vars yet: retry bootstrap.
    """
    with os.fdopen(os.open(path, os.O_RDONLY | os.O_NOFOLLOW | os.O_NONBLOCK), "r") as handle:
        info = os.fstat(handle.fileno())
        if not stat.S_ISREG(info.st_mode) or info.st_uid != os.geteuid() or info.st_size > 1024 * 1024:
            raise ValueError("Unsafe native template environment file")
        original = handle.read(1024 * 1024 + 1)
    marker = "# Happy Latent sanitized native template environment\n"
    if marker not in original.splitlines(keepends=True) and expected:
        # SSH starts before export_env_vars. Wait for each required assignment
        # to be fully written before replacing the export file's inode. Any
        # remaining native writes then go to the unlinked old inode.
        complete = set(original.splitlines(keepends=True))
        if any('export ' + key + '="' + value + '"\n' not in complete for key, value in expected.items()):
            raise RuntimeError("Native template environment export is incomplete; retry bootstrap")
    lines = [marker]
    for line in original.splitlines(keepends=True):
        if line == marker:
            continue
        match = re.match(r"\s*(?:export\s+)?([A-Z_][A-Z0-9_]*)=", line)
        if match and match.group(1) in SECRET_KEYS:
            continue
        lines.append(line)
    fd, temporary = tempfile.mkstemp(prefix=".happylatent-env-", dir=path.parent)
    try:
        with os.fdopen(fd, "w") as handle:
            handle.write("".join(lines))
            handle.flush()
            os.fsync(handle.fileno())
        os.replace(temporary, path)
    finally:
        with contextlib.suppress(FileNotFoundError):
            os.unlink(temporary)


def safe_directory(path: Path, boundary: Path, *, runtime: Path) -> None:
    """Reject every preexisting link between the dedicated workspace and target."""
    relative = path.relative_to(boundary)
    current = boundary
    if boundary.is_symlink() or not boundary.is_dir():
        raise ValueError("Workspace must be a real directory")
    cloud = boundary / ".happylatent-cloud"
    traversable = {cloud, runtime.parent} if runtime.parent == cloud / "runtimes" else set()
    for component in relative.parts:
        current = current / component
        if current.is_symlink() or (current.exists() and not current.is_dir()):
            raise ValueError("Runtime path contains an unsafe component")
        current.mkdir(mode=0o700, exist_ok=True)
        readable_parent = current in traversable or (
            current in (runtime.parent, runtime) and worker.renderer_identity(runtime, required=False) is not None
        )
        current.chmod(0o711 if readable_parent else 0o700)


def worker_alive(pid: int, worker_file: Path, *, proc_root: Path = Path("/proc")) -> bool:
    if type(pid) is not int or pid <= 1:
        raise ValueError("Invalid saved worker PID")
    process = proc_root / str(pid)
    if not process.exists():
        return False
    arguments = (process / "cmdline").read_bytes().split(b"\0")
    if str(worker_file).encode() not in arguments or b"--watchdog" in arguments or b"--setup" in arguments:
        # A template restart can reuse PIDs. Never signal an unrelated process;
        # the inherited advisory lock is the authoritative duplicate-start guard.
        return False
    return True


def start(bundle: Path, *, workspace: Path = Path("/workspace"), environ=None,
          proc_environ: Path = Path("/proc/1/environ"), native_environment: Path = Path("/etc/rp_environment"),
          popen=subprocess.Popen, alive=worker_alive, clock=time.time,
          verify_approval=worker.verify_download_approval) -> dict:
    os.umask(0o077)
    environ = dict(os.environ if environ is None else environ)
    expected_parent = workspace / ".happylatent-cloud" / "bundles"
    if bundle.parent != expected_parent or not re.fullmatch(r"[0-9a-f]{64}", bundle.name):
        raise ValueError("Bundle must be inside the dedicated uploaded bundles directory")
    require_private_storage(workspace)
    selected = recovered_environment(environ, proc_environ)
    lease = worker.read_lease(selected.get("HAPPYLATENT_CLOUD_LEASE", ""))
    if lease.get("networkVolumeId") and not workspace.is_mount():
        raise MissingNetworkVolume("The planned Runpod Network Volume is not mounted at /workspace")
    if lease.get("containerDiskGb") and workspace.is_mount():
        raise UnexpectedWorkspaceMount("Temporary container storage requires /workspace on the container filesystem")
    runtime = worker.runtime_root(workspace, lease)
    safe_directory(bundle, workspace, runtime=runtime)
    setup = worker.read_setup(bundle)
    if setup["media"] != lease["media"] or lease.get("bundleId") != bundle.name or clock() >= worker.timestamp(lease["deadline"]):
        raise ValueError("Lease is expired or does not match the uploaded setup")
    if worker.timestamp(lease["createdAt"]) > clock() + 30:
        raise ValueError("Lease creation time is in the future")
    verify_approval(lease, setup, json.loads((bundle / "models.json").read_text()),
                    destination=workspace / "models", clock=clock)
    sanitize_template_environment(native_environment, expected=selected)
    safe_directory(runtime, workspace, runtime=runtime)
    lock_fd = os.open(runtime / "bootstrap.lock", os.O_CREAT | os.O_RDWR | os.O_NOFOLLOW, 0o600)
    with os.fdopen(lock_fd, "r+") as lock:
        fcntl.flock(lock, fcntl.LOCK_EX)
        ownership = {"version": 2, "bundleId": bundle.name, "podId": selected["RUNPOD_POD_ID"], "lease": lease}
        owner = runtime / "owner.json"
        if owner.exists():
            if owner.is_symlink() or json.loads(owner.read_text()) != ownership:
                raise ValueError("Existing runtime belongs to another lease or setup bundle")
        elif any(p.name != "bootstrap.lock" for p in runtime.iterdir()):
            raise ValueError("Refusing to adopt an existing unowned runtime directory")
        else:
            worker.atomic_json(owner, ownership)
        worker.persist_lease(lease, workspace)
        pidfile = runtime / "worker.json"
        active_fd = os.open(runtime / "worker.lock", os.O_CREAT | os.O_RDWR | os.O_NOFOLLOW, 0o600)
        with os.fdopen(active_fd, "r+") as active_lock:
            try:
                fcntl.flock(active_lock, fcntl.LOCK_EX | fcntl.LOCK_NB)
            except BlockingIOError:
                # The detached worker inherits this lock across spawn, closing
                # the crash window between process creation and PID recording.
                previous = json.loads(pidfile.read_text()) if pidfile.exists() and not pidfile.is_symlink() else {}
                return {"status": "already_running", "runtimeId": lease["runtimeId"],
                        "pid": previous.get("pid"), "deadline": lease["deadline"]}
            worker_file = bundle / "cloud" / "worker.py"
            if pidfile.exists():
                if pidfile.is_symlink():
                    raise ValueError("Unsafe worker PID record")
                previous = json.loads(pidfile.read_text())
                if previous.get("runtimeId") != lease["runtimeId"] or previous.get("bundleId") != bundle.name:
                    raise ValueError("Worker record belongs to another runtime")
                if alive(previous["pid"], worker_file):
                    return {"status": "already_running", "runtimeId": lease["runtimeId"], "pid": previous["pid"], "deadline": lease["deadline"]}
            state = runtime / "state.json"
            if state.exists() and (state.is_symlink() or json.loads(state.read_text()).get("status") in {"stopping", "stopped"}):
                raise ValueError("A stopped runtime cannot be restarted under the same lease")
            # The native template's SSH server remains in charge; do not start sshd.
            environment = {
                "PATH": str(Path(sys.executable).parent) + ":/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin",
                "HOME": "/root", "LANG": "C.UTF-8", "PYTHONUNBUFFERED": "1", "PYTHONDONTWRITEBYTECODE": "1",
                "HF_HUB_DISABLE_IMPLICIT_TOKEN": "1", "HF_HUB_DISABLE_TELEMETRY": "1",
                "HAPPYLATENT_CLOUD_BUNDLE": str(bundle), "HAPPYLATENT_CLOUD_STATE": str(state),
                "HAPPYLATENT_CLOUD_LOCK_FD": str(active_lock.fileno()),
                **selected,
            }
            for key in ("CUDA_HOME", "LD_LIBRARY_PATH", "NVIDIA_VISIBLE_DEVICES", "NVIDIA_DRIVER_CAPABILITIES"):
                value = environ.get(key)
                if value and isinstance(value, str) and len(value) <= 4096 and not any(c in value for c in "\r\n\0"):
                    environment[key] = value
            logfile = runtime / "worker.log"
            fd = os.open(logfile, os.O_WRONLY | os.O_APPEND | os.O_CREAT | os.O_NOFOLLOW, 0o600)
            with os.fdopen(fd, "ab", buffering=0) as log:
                if not stat.S_ISREG(os.fstat(log.fileno()).st_mode):
                    raise ValueError("Unsafe worker log file")
                os.fchmod(log.fileno(), 0o600)
                process = popen(worker.worker_command(sys.executable, worker_file), env=environment, cwd=runtime,
                                stdin=subprocess.DEVNULL, stdout=log, stderr=subprocess.STDOUT,
                                close_fds=True, pass_fds=(active_lock.fileno(),), start_new_session=True)
            worker.atomic_json(pidfile, {"pid": process.pid, "runtimeId": lease["runtimeId"], "bundleId": bundle.name})
            return {"status": "started", "runtimeId": lease["runtimeId"], "pid": process.pid, "deadline": lease["deadline"]}


def status(bundle: Path, *, workspace: Path = Path("/workspace"), environ=None) -> dict:
    selected = recovered_environment(os.environ if environ is None else environ)
    lease = worker.read_lease(selected["HAPPYLATENT_CLOUD_LEASE"])
    if bundle.name != lease["bundleId"]:
        raise ValueError("Bundle does not match the running lease")
    path = worker.runtime_root(workspace, lease) / "state.json"
    if not path.exists():
        return {"status": "booting", "runtimeId": lease["runtimeId"], "podId": selected["RUNPOD_POD_ID"],
                "deadline": lease["deadline"], "stages": {}}
    state = worker.load_state(path)
    if state["runtimeId"] != lease["runtimeId"] or state["podId"] != selected["RUNPOD_POD_ID"]:
        raise ValueError("Worker identity does not match the running lease")
    return {"status": state["status"], "runtimeId": state["runtimeId"], "podId": state["podId"],
            "deadline": lease["deadline"], "stages": state.get("setupStages", {}),
            "watchdogStatus": state.get("watchdog", {}).get("status")}


if __name__ == "__main__":
    try:
        actions = {"--start": start, "--status": status}
        if len(sys.argv) != 2 or sys.argv[1] not in actions:
            raise ValueError("Use --start or --status")
        print(json.dumps(actions[sys.argv[1]](Path(__file__).parent.parent)), flush=True)
    except Exception as error:
        # Provider env, paths, URLs and exception bodies can contain secrets.
        print(json.dumps({"status": "failed", "error": type(error).__name__}), flush=True)
        sys.exit(1)
