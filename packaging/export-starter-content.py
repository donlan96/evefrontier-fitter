"""Export only explicitly approved board geometry and module definitions."""
from __future__ import annotations

import argparse
import json
import sys
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(ROOT / "backend"))
from app.models import BoardDefinition, ModuleDefinition  # noqa: E402


def main() -> None:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--input", required=True, type=Path)
    parser.add_argument("--output", required=True, type=Path)
    args = parser.parse_args()
    data = json.loads(args.input.read_text(encoding="utf-8-sig"))
    boards = []
    for index, entry in enumerate(data["boards"]["savedBoards"], 1):
        board = BoardDefinition.model_validate(entry["board"]).model_dump(by_alias=True, mode="json")
        board["id"] = f"preset-board-{index}"
        boards.append(board)
    modules = []
    for index, raw in enumerate(data["workspace"]["document"]["modules"], 1):
        module = ModuleDefinition.model_validate(raw).model_dump(by_alias=True, mode="json")
        module["id"] = f"preset-module-{index:02}"
        modules.append(module)
    if not boards or not modules:
        raise ValueError("Approved starter content must include boards and modules")
    starter = {"version": 1, "savedAt": "2026-10-07T00:00:00.000Z", "boards": boards, "modules": modules}
    args.output.parent.mkdir(parents=True, exist_ok=True)
    args.output.write_text(json.dumps(starter, ensure_ascii=False, indent=2) + "\n", encoding="utf-8")
    print(json.dumps({"boards": len(boards), "modules": len(modules), "output": str(args.output)}, ensure_ascii=False))


if __name__ == "__main__":
    main()
