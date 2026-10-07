from __future__ import annotations

import sys
from pathlib import Path


def application_resource_root() -> Path:
    """Use the bundled read-only resources when running a frozen executable."""
    if getattr(sys, "frozen", False):
        return Path(sys._MEIPASS)
    return Path(__file__).resolve().parents[2]
