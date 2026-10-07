"""Windows launcher and frozen backend entry point. No external runtimes needed."""
from __future__ import annotations

import argparse
import ctypes
from ctypes import wintypes
import json
import logging
import os
from pathlib import Path
import socket
import subprocess
import sys
import time
from urllib.request import urlopen
import webbrowser

if os.name == "nt":
    kernel = ctypes.WinDLL("kernel32", use_last_error=True)
    kernel.OpenProcess.argtypes = [wintypes.DWORD, wintypes.BOOL, wintypes.DWORD]
    kernel.OpenProcess.restype = wintypes.HANDLE
    kernel.CloseHandle.argtypes = [wintypes.HANDLE]
    kernel.QueryFullProcessImageNameW.argtypes = [wintypes.HANDLE, wintypes.DWORD, wintypes.LPWSTR, ctypes.POINTER(wintypes.DWORD)]
    kernel.GetProcessTimes.argtypes = [wintypes.HANDLE] + [ctypes.POINTER(wintypes.FILETIME)] * 4
    kernel.TerminateProcess.argtypes = [wintypes.HANDLE, wintypes.UINT]
    kernel.CreateMutexW.argtypes = [ctypes.c_void_p, wintypes.BOOL, wintypes.LPCWSTR]
    kernel.CreateMutexW.restype = wintypes.HANDLE
    kernel.WaitForSingleObject.argtypes = [wintypes.HANDLE, wintypes.DWORD]
    kernel.ReleaseMutex.argtypes = [wintypes.HANDLE]


def app_directory() -> Path:
    return Path(sys.executable).resolve().parent if getattr(sys, "frozen", False) else Path(__file__).resolve().parents[1]


def process_identity(pid: int) -> dict | None:
    handle = kernel.OpenProcess(0x1000, False, pid)
    if not handle:
        return None
    try:
        buffer = ctypes.create_unicode_buffer(32768)
        length = wintypes.DWORD(len(buffer))
        created, exited, system_time, user_time = (wintypes.FILETIME() for _ in range(4))
        if not kernel.QueryFullProcessImageNameW(handle, 0, buffer, ctypes.byref(length)):
            return None
        if not kernel.GetProcessTimes(handle, ctypes.byref(created), ctypes.byref(exited), ctypes.byref(system_time), ctypes.byref(user_time)):
            return None
        if exited.dwHighDateTime or exited.dwLowDateTime:
            return None
        return {"pid": pid, "image": str(Path(buffer.value).resolve()), "created": (created.dwHighDateTime << 32) | created.dwLowDateTime}
    finally:
        kernel.CloseHandle(handle)


def owns_process(record: dict, app_dir: Path) -> bool:
    try:
        actual = process_identity(int(record["pid"]))
        expected = {os.path.normcase(str(app_dir / "EveFrontierFitter.exe")), os.path.normcase(str(app_dir / "runtime" / "node.exe"))}
        return bool(actual and actual == record and os.path.normcase(actual["image"]) in expected)
    except (KeyError, TypeError, ValueError, OSError):
        return False


def stop_owned_process(record: dict, app_dir: Path) -> None:
    if not owns_process(record, app_dir):
        return
    handle = kernel.OpenProcess(0x0001 | 0x1000 | 0x00100000, False, int(record["pid"]))
    if not handle:
        return
    try:
        # Recheck creation time after opening to avoid terminating a reused PID.
        if owns_process(record, app_dir):
            kernel.TerminateProcess(handle, 0)
            kernel.WaitForSingleObject(handle, 5000)
    finally:
        kernel.CloseHandle(handle)


def read_state(path: Path) -> dict:
    try:
        value = json.loads(path.read_text(encoding="utf-8"))
        return value if isinstance(value, dict) else {}
    except (OSError, ValueError):
        return {}


def stop_services(state_path: Path, app_dir: Path) -> None:
    state = read_state(state_path)
    for service in ("frontend", "backend"):
        record = state.get(service)
        if isinstance(record, dict):
            stop_owned_process(record, app_dir)
    state_path.unlink(missing_ok=True)


def port_in_use(port: int) -> bool:
    with socket.socket() as connection:
        connection.settimeout(0.5)
        return connection.connect_ex(("127.0.0.1", port)) == 0


def services_ready(frontend_port: int, solver_port: int, version: str) -> bool:
    try:
        with urlopen(f"http://127.0.0.1:{solver_port}/api/health", timeout=1) as response:
            health = json.load(response)
        if health.get("status") != "ok" or health.get("solver") != "ortools-cp-sat" or health.get("version") != version:
            return False
        with urlopen(f"http://localhost:{frontend_port}/", timeout=1) as response:
            page = response.read().decode("utf-8")
        return 'class="app"' in page and "FRONTIER FIT LAB" in page and f"v{version}" in page
    except (OSError, ValueError):
        return False


def message(text: str, *, error: bool = False) -> None:
    ctypes.windll.user32.MessageBoxW(None, text, "舰装格局", 0x10 if error else 0x40)


def run_backend(args: argparse.Namespace, data_root: Path) -> None:
    # PyInstaller windowed executables have no stdout/stderr. Uvicorn logging
    # must use real streams rather than call isatty() on None.
    log_path = data_root / "logs" / "solver.log"
    log_path.parent.mkdir(parents=True, exist_ok=True)
    sys.stdout = sys.stderr = log_path.open("a", encoding="utf-8", buffering=1)
    os.environ["EVE_FRONTIER_FITTER_DATA_PATH"] = str(data_root / "data" / "fitter-data.json")
    os.environ["EVE_FRONTIER_FITTER_DIAGNOSTICS_DIR"] = str(data_root / "diagnostics")
    logging.basicConfig(stream=sys.stderr, level=logging.INFO)
    import uvicorn
    from app.main import app
    uvicorn.run(app, host="127.0.0.1", port=args.solver_port, loop="asyncio", http="h11", ws="none", log_config=None, access_log=False)


def start_services(args: argparse.Namespace, data_root: Path, app_dir: Path, state_path: Path) -> None:
    version = json.loads((app_dir / "package.json").read_text(encoding="utf-8"))["version"]
    state = read_state(state_path)
    records = [state.get(service) for service in ("frontend", "backend")]
    if all(isinstance(record, dict) and owns_process(record, app_dir) for record in records):
        if services_ready(args.frontend_port, args.solver_port, version):
            if not args.no_browser:
                webbrowser.open(f"http://localhost:{args.frontend_port}/")
            return
        stop_services(state_path, app_dir)
    occupied = [port for port in (args.frontend_port, args.solver_port) if port_in_use(port)]
    if occupied:
        raise RuntimeError(f"端口 {', '.join(map(str, occupied))} 已有程序运行。请先使用旧版的停止入口关闭旧版工具，再打开安装版；个人存档会保留。")
    node = app_dir / "runtime" / "node.exe"
    server = app_dir / "web" / "server.js"
    if not node.is_file() or not server.is_file():
        raise RuntimeError("安装文件不完整，请重新安装舰装格局。个人存档无需删除。")
    log_root = data_root / "logs"
    log_root.mkdir(parents=True, exist_ok=True)
    created: list[subprocess.Popen] = []
    streams = []
    try:
        backend = subprocess.Popen([str(app_dir / "EveFrontierFitter.exe"), "--serve-backend", "--solver-port", str(args.solver_port), "--data-root", str(data_root)], creationflags=subprocess.CREATE_NO_WINDOW)
        created.append(backend)
        frontend_env = {**os.environ, "HOST": "127.0.0.1", "HOSTNAME": "127.0.0.1", "PORT": str(args.frontend_port), "NODE_ENV": "production"}
        frontend_log = (log_root / "frontend.log").open("a", encoding="utf-8")
        streams.append(frontend_log)
        frontend = subprocess.Popen([str(node), str(server)], cwd=app_dir / "web", env=frontend_env, stdout=frontend_log, stderr=subprocess.STDOUT, creationflags=subprocess.CREATE_NO_WINDOW)
        created.append(frontend)
        deadline = time.monotonic() + 60
        while time.monotonic() < deadline:
            if any(process.poll() is not None for process in created):
                raise RuntimeError(f"启动服务失败，请查看日志：{log_root}")
            if services_ready(args.frontend_port, args.solver_port, version):
                break
            time.sleep(0.25)
        else:
            raise RuntimeError(f"启动等待超时，请查看日志：{log_root}")
        state = {"version": version, "frontend": process_identity(frontend.pid), "backend": process_identity(backend.pid)}
        if not state["frontend"] or not state["backend"]:
            raise RuntimeError("无法核对服务进程，请重新打开工具。")
        temporary = state_path.with_suffix(".tmp")
        temporary.write_text(json.dumps(state), encoding="utf-8")
        os.replace(temporary, state_path)
        if not args.no_browser:
            webbrowser.open(f"http://localhost:{args.frontend_port}/")
    except BaseException:
        for process in reversed(created):
            if process.poll() is None:
                process.terminate()
                process.wait(timeout=10)
        raise
    finally:
        for stream in streams:
            stream.close()


def main() -> int:
    parser = argparse.ArgumentParser()
    parser.add_argument("--serve-backend", action="store_true")
    parser.add_argument("--stop", action="store_true")
    parser.add_argument("--silent", action="store_true")
    parser.add_argument("--no-browser", action="store_true")
    parser.add_argument("--frontend-port", type=int, default=3000)
    parser.add_argument("--solver-port", type=int, default=8765)
    parser.add_argument("--data-root", type=Path)
    args = parser.parse_args()
    default_root = Path(os.environ["LOCALAPPDATA"]) / "EveFrontierFitter"
    data_root = (args.data_root or default_root).resolve()
    if args.serve_backend:
        run_backend(args, data_root)
        return 0
    app_dir = app_directory()
    state_path = data_root / "installed-processes.json"
    data_root.mkdir(parents=True, exist_ok=True)
    # Serialise launches/stops in this Windows session. The backend continues
    # running after this short-lived launcher exits.
    mutex = kernel.CreateMutexW(None, False, "Local\\EveFrontierFitterLauncher")
    acquired = False
    try:
        acquired = kernel.WaitForSingleObject(mutex, 15000) in (0, 0x80)
        if not acquired:
            raise RuntimeError("另一个启动或停止操作尚未完成，请稍后重试。")
        if args.stop:
            stop_services(state_path, app_dir)
            if not args.silent:
                message("舰装格局已停止。个人存档、棋盘和配装均已保留。")
        else:
            start_services(args, data_root, app_dir, state_path)
        return 0
    except Exception as error:
        log = data_root / "logs" / "launcher.log"
        log.parent.mkdir(parents=True, exist_ok=True)
        with log.open("a", encoding="utf-8") as output:
            output.write(f"{time.strftime('%Y-%m-%d %H:%M:%S')} {error}\n")
        if not args.silent and not args.no_browser:
            message(str(error), error=True)
        return 1
    finally:
        if acquired:
            kernel.ReleaseMutex(mutex)
        kernel.CloseHandle(mutex)


if __name__ == "__main__":
    raise SystemExit(main())
