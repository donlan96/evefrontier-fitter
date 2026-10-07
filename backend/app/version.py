from __future__ import annotations

import json
from pathlib import Path
from app.resources import application_resource_root


_PACKAGE_JSON = application_resource_root() / "package.json"


def read_app_version() -> str:
    with _PACKAGE_JSON.open(encoding="utf-8") as package_file:
        package_metadata = json.load(package_file)
    return str(package_metadata["version"])


APP_VERSION = read_app_version()
