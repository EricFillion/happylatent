"""Keep media I/O attached to an opened directory, never to a checked pathname.

``root`` is trusted application configuration and may itself be a symlink. Its
canonical path is anchored before traversing untrusted relative components.
Symlinks/reparse points below that root are rejected. POSIX operations use
directory descriptors; Windows uses handle-relative NtCreateFile opens with
OBJ_DONT_REPARSE, and deletes entries through their opened handles.
Canonical roots are remembered for the process lifetime: deliberately changing
a configured root symlink's target requires restarting ComfyUI.

This protects against pathname replacement. It does not isolate files from a
local process that already has permission to modify their contents or make
hard links to them.
"""
from __future__ import annotations

from contextlib import contextmanager
import errno
import os
from pathlib import Path
import stat
import threading


_ROOTS = {}
_ROOT_LOCK = threading.Lock()


def _canonical_root(root):
    # Only application configuration reaches this cache. Never evict entries:
    # re-resolving a previously trusted path could follow a substituted symlink.
    configured = os.path.abspath(os.fspath(root))
    with _ROOT_LOCK:
        if configured not in _ROOTS:
            _ROOTS[configured] = Path(configured).resolve(strict=True)
        return _ROOTS[configured]


def _component(value):
    if (not isinstance(value, str) or not value or value in (".", "..")
            or any(character in value for character in ("/", "\\", "\0", ":"))):
        raise ValueError("Expected one ordinary filename component.")
    if os.name == "nt" and (value[-1:] in (" ", ".")
                            or value.split(".", 1)[0].upper() in {
                                "CON", "PRN", "AUX", "NUL",
                                *(f"COM{index}" for index in range(1, 10)),
                                *(f"LPT{index}" for index in range(1, 10)),
                            }):
        raise ValueError("Unsupported Windows filename component.")
    return value


def _components(relative):
    if relative == "":
        return ()
    if not isinstance(relative, str):
        raise ValueError("Expected a relative directory string.")
    return tuple(_component(part) for part in relative.split("/"))


def _mode(mode):
    if mode not in ("rb", "xb", "x+b"):
        raise ValueError("Safe files support rb, xb, and x+b modes only.")
    return mode


class _PosixDirectory:
    def __init__(self, descriptor):
        self._descriptor = descriptor

    def _check_open(self):
        if self._descriptor is None:
            raise ValueError("The directory is closed.")

    def open_file(self, name, mode="rb"):
        self._check_open()
        name, mode = _component(name), _mode(mode)
        flags = os.O_NOFOLLOW | os.O_CLOEXEC | os.O_NONBLOCK
        if mode == "rb":
            flags |= os.O_RDONLY
        else:
            flags |= os.O_CREAT | os.O_EXCL | (os.O_RDWR if mode == "x+b" else os.O_WRONLY)
        descriptor = os.open(name, flags, 0o600, dir_fd=self._descriptor)
        try:
            if not stat.S_ISREG(os.fstat(descriptor).st_mode):
                raise OSError(errno.EINVAL, "Media must be a regular file.")
            # O_NONBLOCK prevents a substituted FIFO from hanging the open.
            # Regular files are returned with ordinary blocking semantics.
            os.set_blocking(descriptor, True)
            result = os.fdopen(descriptor, mode)
        except BaseException:
            os.close(descriptor)
            raise
        return result

    def unlink(self, name, *, missing_ok=True):
        self._check_open()
        try:
            os.unlink(_component(name), dir_fd=self._descriptor)
        except FileNotFoundError:
            if not missing_ok:
                raise

    def close(self):
        if self._descriptor is not None:
            os.close(self._descriptor)
            self._descriptor = None


def _posix_directory(root, relative, create):
    required = (os.open, os.mkdir, os.unlink)
    if (not all(operation in os.supports_dir_fd for operation in required)
            or not all(hasattr(os, flag) for flag in ("O_DIRECTORY", "O_NOFOLLOW", "O_CLOEXEC"))):
        raise OSError(errno.ENOTSUP, "Secure directory operations are unavailable.")
    access = getattr(os, "O_SEARCH", getattr(os, "O_PATH", os.O_RDONLY))
    flags = access | os.O_DIRECTORY | os.O_NOFOLLOW | os.O_CLOEXEC
    descriptor = os.open(root.anchor, flags)
    try:
        # Trusted canonical root components must also resist replacement after
        # resolve(). No later operation follows their pathname again.
        for name in root.parts[1:]:
            child = os.open(name, flags, dir_fd=descriptor)
            os.close(descriptor)
            descriptor = child
        for name in relative:
            if create:
                try:
                    os.mkdir(name, 0o700, dir_fd=descriptor)
                except FileExistsError:
                    pass
            child = os.open(name, flags, dir_fd=descriptor)
            os.close(descriptor)
            descriptor = child
        return _PosixDirectory(descriptor)
    except BaseException:
        os.close(descriptor)
        raise


class _WindowsDirectory:
    """Open each child relative to a handle, rejecting all reparse traversal.

    Sharing flags alone cannot stop in-place reparse changes: Windows permits
    those through FILE_WRITE_ATTRIBUTES, which is exempt from share checks.
    NtCreateFile's RootDirectory and OBJ_DONT_REPARSE protect the actual lookup.
    """

    def __init__(self, root, relative, create):
        import ctypes
        from ctypes import wintypes

        self._ctypes = ctypes
        self._kernel = ctypes.WinDLL("kernel32", use_last_error=True)
        self._nt = ctypes.WinDLL("ntdll", use_last_error=True)
        self._kernel.CreateFileW.argtypes = (
            wintypes.LPCWSTR, wintypes.DWORD, wintypes.DWORD, wintypes.LPVOID,
            wintypes.DWORD, wintypes.DWORD, wintypes.HANDLE,
        )
        self._kernel.CreateFileW.restype = wintypes.HANDLE
        self._kernel.CloseHandle.argtypes = (wintypes.HANDLE,)
        self._kernel.CloseHandle.restype = wintypes.BOOL
        self._kernel.GetFileType.argtypes = (wintypes.HANDLE,)
        self._kernel.GetFileType.restype = wintypes.DWORD
        self._kernel.GetFileInformationByHandleEx.argtypes = (
            wintypes.HANDLE, ctypes.c_int, wintypes.LPVOID, wintypes.DWORD,
        )
        self._kernel.GetFileInformationByHandleEx.restype = wintypes.BOOL
        self._kernel.SetFileInformationByHandle.argtypes = (
            wintypes.HANDLE, ctypes.c_int, wintypes.LPVOID, wintypes.DWORD,
        )
        self._kernel.SetFileInformationByHandle.restype = wintypes.BOOL

        class AttributeTagInfo(ctypes.Structure):
            _fields_ = (("FileAttributes", wintypes.DWORD), ("ReparseTag", wintypes.DWORD))

        class UnicodeString(ctypes.Structure):
            _fields_ = (("Length", wintypes.USHORT), ("MaximumLength", wintypes.USHORT),
                        ("Buffer", wintypes.LPWSTR))

        class ObjectAttributes(ctypes.Structure):
            _fields_ = (("Length", wintypes.ULONG), ("RootDirectory", wintypes.HANDLE),
                        ("ObjectName", ctypes.POINTER(UnicodeString)), ("Attributes", wintypes.ULONG),
                        ("SecurityDescriptor", wintypes.LPVOID), ("SecurityQualityOfService", wintypes.LPVOID))

        class IoStatusBlock(ctypes.Structure):
            # The native first member is a union of NTSTATUS and PVOID.
            _fields_ = (("StatusOrPointer", ctypes.c_void_p), ("Information", ctypes.c_size_t))

        self._unicode_string, self._object_attributes, self._io_status = UnicodeString, ObjectAttributes, IoStatusBlock
        self._attribute_info = AttributeTagInfo
        self._handle_type = wintypes.HANDLE
        self._nt.NtCreateFile.argtypes = (
            ctypes.POINTER(wintypes.HANDLE), wintypes.DWORD, ctypes.POINTER(ObjectAttributes),
            ctypes.POINTER(IoStatusBlock), wintypes.LPVOID, wintypes.ULONG, wintypes.ULONG,
            wintypes.ULONG, wintypes.ULONG, wintypes.LPVOID, wintypes.ULONG,
        )
        self._nt.NtCreateFile.restype = wintypes.LONG
        self._nt.RtlNtStatusToDosError.argtypes = (wintypes.LONG,)
        self._nt.RtlNtStatusToDosError.restype = wintypes.ULONG
        self._handles = []
        try:
            # The drive/share anchor is trusted configuration. Every component
            # after it, including configured root components, is handle-relative.
            anchor = self._kernel.CreateFileW(root.anchor, 0x1000A0, 0x1 | 0x2, None, 3,
                                             0x00200000 | 0x02000000, None)
            if anchor == ctypes.c_void_p(-1).value:
                raise ctypes.WinError(ctypes.get_last_error())
            self._handles.append(anchor)
            self._validate(anchor, directory=True)
            for name in root.parts[1:]:
                self._handles.append(self._open(name, directory=True))
            for name in relative:
                self._handles.append(self._open(name, directory=True, create=create))
        except BaseException:
            self.close()
            raise

    def _validate(self, handle, *, directory, allow_reparse=False):
        info = self._attribute_info()
        if not self._kernel.GetFileInformationByHandleEx(handle, 9, self._ctypes.byref(info),
                                                         self._ctypes.sizeof(info)):
            raise self._ctypes.WinError(self._ctypes.get_last_error())
        if info.FileAttributes & 0x400 and not allow_reparse:
            raise OSError(errno.ELOOP, "Media paths cannot contain reparse points.")
        if bool(info.FileAttributes & 0x10) != directory or self._kernel.GetFileType(handle) != 1:
            raise OSError(errno.EINVAL, "Media must be a regular file or directory.")

    def _open(self, name, *, directory=False, create=False, mode="rb", delete=False):
        ctypes = self._ctypes
        encoded = name.encode("utf-16-le")
        if len(encoded) > 65532:
            raise ValueError("Filename component is too long.")
        buffer = ctypes.create_string_buffer(encoded + b"\0\0")
        name_string = self._unicode_string(len(encoded), len(encoded) + 2,
                                           ctypes.cast(buffer, self._unicode_string._fields_[2][1]))
        attributes = self._object_attributes(ctypes.sizeof(self._object_attributes), self._handles[-1],
                                             ctypes.pointer(name_string), 0x40 | 0x1000, None, None)
        # OBJ_CASE_INSENSITIVE | OBJ_DONT_REPARSE applies to the lookup itself.
        # FILE_OPEN_REPARSE_POINT also prevents following the final entry.
        options = 0x00200000 | 0x20 | (0x1 if directory else 0x40)
        access = 0x100080  # SYNCHRONIZE | FILE_READ_ATTRIBUTES
        if directory:
            access |= 0x20  # FILE_TRAVERSE
        elif delete:
            access |= 0x10000  # DELETE
        else:
            access |= 0x80000000 if mode == "rb" else 0x40000000
            if mode == "x+b":
                access |= 0x80000000
        disposition = (3 if create else 1) if directory else (1 if mode == "rb" else 2)
        handle, status = self._handle_type(), self._io_status()
        result = self._nt.NtCreateFile(ctypes.byref(handle), access, ctypes.byref(attributes),
                                      ctypes.byref(status), None, 0x10 if directory else 0x80,
                                      0x1 | 0x2, disposition, options, None, 0)
        if result < 0:
            raise ctypes.WinError(self._nt.RtlNtStatusToDosError(result))
        try:
            self._validate(handle, directory=directory, allow_reparse=delete)
        except BaseException:
            self._kernel.CloseHandle(handle)
            raise
        return handle.value

    def _check_open(self):
        if not self._handles:
            raise ValueError("The directory is closed.")

    def open_file(self, name, mode="rb"):
        import msvcrt

        self._check_open()
        name, mode = _component(name), _mode(mode)
        handle = self._open(name, mode=mode)
        flags = os.O_BINARY | (os.O_RDONLY if mode == "rb" else os.O_RDWR if mode == "x+b" else os.O_WRONLY)
        try:
            descriptor = msvcrt.open_osfhandle(handle, flags)
        except BaseException:
            self._kernel.CloseHandle(handle)
            raise
        try:
            return os.fdopen(descriptor, mode)
        except BaseException:
            os.close(descriptor)
            raise

    def unlink(self, name, *, missing_ok=True):
        self._check_open()
        # Delete the opened entry itself, never reconstruct a pathname. If a
        # filesystem refuses a no-reparse open, cleanup fails closed as well.
        try:
            handle = self._open(_component(name), delete=True)
        except FileNotFoundError:
            if not missing_ok:
                raise
            return
        try:
            disposition = self._ctypes.c_ubyte(1)  # FILE_DISPOSITION_INFO.DeleteFile
            if not self._kernel.SetFileInformationByHandle(handle, 4, self._ctypes.byref(disposition), 1):
                raise self._ctypes.WinError(self._ctypes.get_last_error())
        finally:
            self._kernel.CloseHandle(handle)

    def close(self):
        while self._handles:
            self._kernel.CloseHandle(self._handles.pop())


@contextmanager
def open_directory(root: Path, relative: str = "", *, create=False):
    """Open a trusted root and safely traverse/create relative directories.

    Keep this context alive through all reads, writes, and cleanup. New files
    must use exclusive ``xb`` or ``x+b`` creation, never a truncating mode.
    Directory and file handles remain private; callers receive binary streams
    suitable for Pillow, PyAV, wave, hashing, and HTTP response streaming.
    """
    components = _components(relative)
    canonical_root = _canonical_root(root)
    if os.name == "posix":
        directory = _posix_directory(canonical_root, components, create)
    elif os.name == "nt":
        directory = _WindowsDirectory(canonical_root, components, create)
    else:
        raise OSError(errno.ENOTSUP, "Secure directory operations are unavailable.")
    try:
        yield directory
    finally:
        directory.close()
