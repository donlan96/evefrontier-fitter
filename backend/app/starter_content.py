from __future__ import annotations

import json
from pathlib import Path
from typing import Literal

from pydantic import BaseModel, ConfigDict, Field, model_validator

from app.models import BoardDefinition, ModuleDefinition
from app.resources import application_resource_root


class StarterContent(BaseModel):
    model_config = ConfigDict(extra="forbid")
    version: Literal[1]
    savedAt: str
    boards: list[BoardDefinition] = Field(min_length=1)
    modules: list[ModuleDefinition] = Field(min_length=1)

    @model_validator(mode="after")
    def unique_identifiers(self) -> "StarterContent":
        for values in (self.boards, self.modules):
            if len({value.id for value in values}) != len(values):
                raise ValueError("starter content contains duplicate IDs")
        return self


def default_starter_path() -> Path:
    return application_resource_root() / "resources" / "starter-content.json"


def starter_document(path: Path) -> dict:
    content = StarterContent.model_validate_json(path.read_bytes())
    boards = [board.model_dump(by_alias=True, mode="json") for board in content.boards]
    modules = [module.model_dump(by_alias=True, mode="json") for module in content.modules]
    board = boards[0]
    return {
        "schemaVersion": 1, "revision": 0, "savedAt": None,
        "boards": {"version": 3, "savedBoards": [{"board": item, "savedAt": content.savedAt} for item in boards], "history": []},
        "fittings": {"version": 3, "entries": []},
        "solutionHistory": {"version": 3, "models": {}},
        "workspace": {
            "snapshotVersion": 3, "savedAt": content.savedAt,
            "document": {
                "documentType": "eve-frontier-grid-fitting", "schemaVersion": 1,
                "board": board, "modules": modules,
                "build": {"id": "starter-build", "name": f"{board['name']} 配装", "boardId": board["id"], "placements": []},
            },
            "fitting": {"activeFittingId": None, "name": f"{board['name']} 配装", "description": ""},
            "solver": {
                "rules": [{"moduleId": item["id"], "requiredCount": 0, "enabled": False, "maxCount": item["availableQuantity"]} for item in modules],
                "scope": "fill-current", "timeLimitMs": 30_000,
                "searchWorkers": {"mode": "standard", "value": None},
                "lockedPlacementIds": [], "lastResult": None, "lastResultFingerprint": None,
            },
        },
    }
