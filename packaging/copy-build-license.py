import importlib.metadata
from pathlib import Path
import sys

distribution = importlib.metadata.distribution("pyinstaller")
licenses = [distribution.locate_file(file) for file in distribution.files or [] if str(file).lower().endswith("copying.txt")]
if len(licenses) != 1:
    raise RuntimeError(f"Expected one PyInstaller COPYING.txt, found {len(licenses)}")
Path(sys.argv[1]).write_bytes(licenses[0].read_bytes())
