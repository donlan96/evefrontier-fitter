"""Check the actual frozen package using isolated data and unused local ports."""
from __future__ import annotations

import argparse
import json
import os
import re
from pathlib import Path
import socket
import subprocess
import time
from urllib.request import Request, urlopen
from urllib.parse import urljoin


def json_request(url: str, payload=None, method="GET"):
    body = json.dumps(payload).encode() if payload is not None else None
    with urlopen(Request(url, data=body, method=method, headers={"Content-Type": "application/json"}), timeout=10) as response:
        return json.load(response)


def main():
    parser = argparse.ArgumentParser()
    parser.add_argument("--app-dir", required=True, type=Path)
    parser.add_argument("--work-dir", required=True, type=Path)
    args = parser.parse_args()
    app_dir = args.app_dir.resolve()
    for parent in app_dir.parents:
        if (parent / "node_modules").exists():
            raise RuntimeError(f"Test installation must be outside developer dependency directories: {parent}")
    expected_version = json.loads((app_dir / "package.json").read_bytes())["version"]
    data_root = args.work_dir.resolve()
    if data_root.exists():
        raise RuntimeError("Use a new empty smoke-test directory")
    data_root.mkdir(parents=True)
    exe = app_dir / "EveFrontierFitter.exe"
    # Strip developer runtimes from PATH and Python lookup variables.
    environment = {key: value for key, value in os.environ.items() if key.upper() not in ("PYTHONPATH", "PYTHONHOME", "NODE_PATH", "NODE_OPTIONS")}
    environment["PATH"] = str(Path(os.environ["SystemRoot"]) / "System32")
    flags = subprocess.CREATE_NO_WINDOW
    ports = (13000, 18765)
    for port in ports:
        with socket.socket() as connection:
            if connection.connect_ex(("127.0.0.1", port)) == 0:
                raise RuntimeError(f"Smoke port {port} is occupied")
    launch = [str(exe), "--no-browser", "--frontend-port", str(ports[0]), "--solver-port", str(ports[1]), "--data-root", str(data_root)]
    stop = [str(exe), "--stop", "--silent", "--data-root", str(data_root)]
    api = f"http://127.0.0.1:{ports[1]}/api"
    try:
        subprocess.run(launch, env=environment, creationflags=flags, check=True, timeout=90)
        health = json_request(f"{api}/health")
        assert health["version"] == expected_version
        with urlopen(f"http://localhost:{ports[0]}/", timeout=10) as response:
            html = response.read().decode()
        assert 'class="app"' in html and f"v{expected_version}" in html
        script_urls = re.findall(r'<script[^>]+src="([^"]+)"', html)
        assert script_urls, "Frontend HTML must load browser scripts"
        for script_url in script_urls:
            with urlopen(urljoin(f"http://localhost:{ports[0]}/", script_url), timeout=10) as response:
                assert response.status == 200 and "javascript" in response.headers.get("Content-Type", "").lower()
        loaded = json_request(f"{api}/data")
        assert loaded["source"] == "empty"
        seed = loaded["document"]
        assert [entry["board"]["name"] for entry in seed["boards"]["savedBoards"]] == ["掠夺者", "初始飞船"]
        assert len(seed["workspace"]["document"]["modules"]) == 23
        assert not seed["workspace"]["document"]["build"]["placements"]
        assert seed["workspace"]["solver"]["lastResult"] is None
        request = {
            "board": {"id": "smoke", "name": "smoke", "width": 4, "height": 1, "mask": [[1, 1, 1, 1]]},
            "modules": [{"id": "cargo", "name": "cargo", "type": "cargo", "baseShape": [{"x": 0, "y": 0}], "color": "#000000", "availableQuantity": 4, "allowRotation": True, "allowMirror": False, "baseScore": 1.25, "attributes": {}}],
            "moduleRules": [{"moduleId": "cargo", "requiredCount": 0, "enabled": True, "maxCount": 4}],
            "scope": "empty-board", "lockedPlacements": [], "currentLayout": [], "historyBestLayout": None, "timeLimitMs": 30_000,
        }
        job = json_request(f"{api}/solver/solve", request, "POST")
        deadline = time.monotonic() + 15
        while job["status"] in ("queued", "running") and time.monotonic() < deadline:
            time.sleep(0.05)
            job = json_request(f"{api}/solver/status/{job['jobId']}")
        assert job["provenOptimal"] and job["solverStatus"] == "OPTIMAL", job
        assert job["score"] == 5 and len(job["bestSolution"]["placements"]) == 4
        seed["revision"] = 1
        seed["workspace"]["fitting"]["description"] = "isolated user data survives restart"
        json_request(f"{api}/data", seed, "PUT")
        data_file = data_root / "data" / "fitter-data.json"
        before = data_file.read_bytes()
        state = json.loads((data_root / "installed-processes.json").read_text())
        assert all(Path(state[service]["image"]).is_relative_to(app_dir) for service in ("frontend", "backend"))
        subprocess.run(stop, env=environment, creationflags=flags, check=True, timeout=20)
        for port in ports:
            with socket.socket() as connection:
                assert connection.connect_ex(("127.0.0.1", port)) != 0
        subprocess.run(launch, env=environment, creationflags=flags, check=True, timeout=90)
        reloaded = json_request(f"{api}/data")
        assert reloaded["source"] == "primary"
        assert reloaded["document"]["workspace"]["fitting"]["description"] == "isolated user data survives restart"
        assert data_file.read_bytes() == before
        print(json.dumps({"version": health["version"], "boards": 2, "modules": 23, "nativeSolverScore": job["score"], "strictOptimal": True, "restartPreservesBytes": True, "runtimePath": "system-only"}))
    finally:
        subprocess.run(stop, env=environment, creationflags=flags, timeout=20)


if __name__ == "__main__":
    main()
