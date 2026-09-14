"""Backend entrypoint.

Run standalone for development:
    python backend/main.py
Or spawned by the Tauri shell, which passes --parent-pid so the server exits
with the app even if the shell is killed without a clean shutdown (FR12).
"""

from __future__ import annotations

import argparse
import os
import sys
import threading
import time
from pathlib import Path

# Allow `python backend/main.py` from anywhere: the package uses flat imports
# (config, routes.*, services.*) exactly as it will after PyInstaller bundling.
sys.path.insert(0, str(Path(__file__).resolve().parent))

import config  # noqa: E402


def _watch_parent(parent_pid: int, interval: float = 2.0) -> None:
    """Exit when the Tauri shell goes away.

    Same watchdog pattern as Voicebox: a hard-killed parent would otherwise
    leave the Python server (and a loaded model, holding VRAM) running forever.

    Nothing in this loop may raise. The shell hands us a stdout pipe it never
    fully drains, so the moment it dies our writes start failing — and an
    exception here used to kill the watchdog thread just before it called
    os._exit, leaving exactly the orphan it exists to prevent.
    """
    while True:
        time.sleep(interval)
        try:
            alive = _pid_alive(parent_pid)
        except Exception:  # noqa: BLE001 - can't check ⇒ assume we're orphaned
            alive = False
        if not alive:
            try:
                print(f"[voicecraft] parent {parent_pid} exited; shutting down", flush=True)
            except Exception:  # noqa: BLE001 - the dead parent owned that pipe
                pass
            os._exit(0)


def _pid_alive(pid: int) -> bool:
    if sys.platform == "win32":
        import ctypes
        from ctypes import wintypes

        kernel32 = ctypes.WinDLL("kernel32", use_last_error=True)
        # Declaring these matters: without an explicit restype ctypes assumes
        # c_int and truncates the 64-bit HANDLE, after which every call on it
        # fails and the watchdog concludes the parent is still alive forever.
        kernel32.OpenProcess.argtypes = (wintypes.DWORD, wintypes.BOOL, wintypes.DWORD)
        kernel32.OpenProcess.restype = wintypes.HANDLE
        kernel32.WaitForSingleObject.argtypes = (wintypes.HANDLE, wintypes.DWORD)
        kernel32.WaitForSingleObject.restype = wintypes.DWORD
        kernel32.CloseHandle.argtypes = (wintypes.HANDLE,)
        kernel32.CloseHandle.restype = wintypes.BOOL

        SYNCHRONIZE = 0x00100000
        WAIT_OBJECT_0 = 0x00000000
        handle = kernel32.OpenProcess(SYNCHRONIZE, False, pid)
        if not handle:
            return False  # gone, or we can't see it — either way, stop waiting
        try:
            # The process object becomes signalled when the process exits.
            return kernel32.WaitForSingleObject(handle, 0) != WAIT_OBJECT_0
        finally:
            kernel32.CloseHandle(handle)
    try:
        os.kill(pid, 0)
        return True
    except OSError:
        return False


def main() -> None:
    parser = argparse.ArgumentParser(prog="voicecraft-backend")
    parser.add_argument("--host", default=config.HOST)
    parser.add_argument("--port", type=int, default=config.PORT)
    parser.add_argument("--parent-pid", type=int, default=None)
    parser.add_argument("--reload", action="store_true")
    args = parser.parse_args()

    if args.parent_pid:
        threading.Thread(
            target=_watch_parent, args=(args.parent_pid,), daemon=True
        ).start()

    import uvicorn

    config.ensure_dirs()
    uvicorn.run(
        "app:app",
        host=args.host,
        port=args.port,
        reload=args.reload,
        log_level="info",
    )


if __name__ == "__main__":
    main()
