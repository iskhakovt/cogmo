"""The image's pydantic against `contract/runtime-packages.json`, which Cogmo generates.

Cogmo's host refuses a skill lockfile by these pins and floors, and a Cogmo test
checks the pins against Pyodide's; this checks them against the pydantic the
image installs.
"""

import importlib.metadata
import json
import re
from pathlib import Path

RUNTIME = json.loads((Path(__file__).parent.parent / "contract" / "runtime-packages.json").read_text())


def test_the_image_installs_the_pinned_pydantic() -> None:
    for name, version in RUNTIME["pins"].items():
        assert importlib.metadata.version(name) == version


def test_the_floors_are_pydantic_s_own_requirements() -> None:
    floors: dict[str, str] = {}
    pins: dict[str, str] = {}
    for requirement in importlib.metadata.requires("pydantic") or []:
        if "extra ==" in requirement:
            continue
        match = re.fullmatch(r"([A-Za-z0-9_.-]+)(>=|==)([^;,\s]+)", requirement.strip())
        assert match is not None, requirement
        name, operator, version = match.groups()
        (floors if operator == ">=" else pins)[name.lower().replace("_", "-")] = version
    assert floors == RUNTIME["floors"]
    assert pins == {"pydantic-core": RUNTIME["pins"]["pydantic-core"]}
