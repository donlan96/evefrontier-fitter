from pathlib import Path
import sys
from PyInstaller.utils.hooks import collect_all, copy_metadata

root = Path(SPECPATH).parent
ortools_data, ortools_binaries, ortools_imports = collect_all("ortools")
metadata = []
for name in ("ortools", "fastapi", "uvicorn"):
    metadata += copy_metadata(name, recursive=True)
a = Analysis(
    [str(root / "packaging" / "launcher.py")],
    pathex=[str(root / "backend")],
    binaries=ortools_binaries,
    datas=ortools_data + metadata + [
        (str(root / "package.json"), "."),
        (str(root / "resources" / "starter-content.json"), "resources"),
        (str(Path(sys.base_prefix) / "LICENSE.txt"), "licenses/python"),
    ],
    hiddenimports=ortools_imports + ["uvicorn.loops.asyncio", "uvicorn.protocols.http.h11_impl", "uvicorn.lifespan.on"],
    excludes=["pytest", "httpx", "tkinter", "IPython", "matplotlib"],
    noarchive=False,
)
pyz = PYZ(a.pure)
exe = EXE(pyz, a.scripts, [], exclude_binaries=True, name="EveFrontierFitter", console=False, upx=False)
collection = COLLECT(exe, a.binaries, a.datas, strip=False, upx=False, name="EveFrontierFitter")
