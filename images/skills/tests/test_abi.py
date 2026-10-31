"""The ABI tag that names skill venvs, as the supervisor and the host's
shell scripts both read it."""

import re
import subprocess
import sys
from pathlib import Path

from cogmo_skills_runtime.abi import python_abi_tag

# The scripts' command, `PYTHON_ABI_TAG_COMMAND` in
# `apps/server/src/skills/deps.ts`. `-I` ignores `PYTHONPATH`, so it finds the
# package as the image does: installed in the interpreter's environment.
_TAG_COMMAND = [sys.executable, "-I", "-m", "cogmo_skills_runtime.abi"]


def test_tag_is_the_running_python_major_and_minor() -> None:
    """`deps-reaper.ts` deletes only `<hash>` and
    `<hash>-py<major>.<minor>` directories, so the tag keeps that shape,
    and a venv is per Python minor, so the tag names the running one."""
    tag = python_abi_tag()
    assert re.fullmatch(r"py[0-9]+\.[0-9]+", tag)
    assert tag == f"py{sys.version_info.major}.{sys.version_info.minor}"


def test_module_entry_point_prints_the_tag_and_nothing_else() -> None:
    """The populate and reap scripts take `$(python3 -I -m
    cogmo_skills_runtime.abi)` as the tag: stdout carries it alone, and
    stderr stays empty."""
    proc = subprocess.run(_TAG_COMMAND, capture_output=True, text=True, check=False)
    assert proc.returncode == 0, proc.stderr
    assert proc.stdout == f"{python_abi_tag()}\n"
    assert proc.stderr == ""


def test_entry_point_ignores_a_package_planted_in_its_cwd(tmp_path: Path) -> None:
    """`-m` puts the cwd first on `sys.path`. `-I` leaves it off, so the
    scripts run the image's module whatever directory they run in, and a
    `cogmo_skills_runtime` planted in that directory never runs."""
    planted = tmp_path / "cogmo_skills_runtime"
    planted.mkdir()
    (planted / "__init__.py").write_text("")
    (planted / "abi.py").write_text('print("pyplanted")\n')

    def stdout(command: list[str]) -> str:
        return subprocess.run(command, cwd=tmp_path, capture_output=True, text=True, check=True).stdout

    # Without `-I` the planted module runs, so the plant is one `-I` defeats.
    assert stdout([sys.executable, "-m", "cogmo_skills_runtime.abi"]) == "pyplanted\n"
    assert stdout(_TAG_COMMAND) == f"{python_abi_tag()}\n"
