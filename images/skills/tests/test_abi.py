"""The ABI tag that names skill venvs, as the supervisor and the host's
shell scripts both read it."""

import os
import subprocess
import sys
from pathlib import Path

import cogmo_skills_runtime
from cogmo_skills_runtime.abi import python_abi_tag

_SRC_DIR = str(Path(cogmo_skills_runtime.__file__).resolve().parent.parent)


def test_tag_is_the_running_python_major_and_minor() -> None:
    """`deps-reaper.ts` deletes only `<hash>` and
    `<hash>-py<major>.<minor>` directories, so the tag keeps that shape."""
    assert python_abi_tag() == f"py{sys.version_info.major}.{sys.version_info.minor}"


def test_module_entry_point_prints_the_tag_and_nothing_else() -> None:
    """The populate and reap scripts take `$(python3 -m
    cogmo_skills_runtime.abi)` as the tag: stdout carries it alone, and
    stderr stays empty."""
    env = {**os.environ, "PYTHONPATH": _SRC_DIR}
    proc = subprocess.run(
        [sys.executable, "-m", "cogmo_skills_runtime.abi"],
        capture_output=True,
        text=True,
        env=env,
        check=False,
    )
    assert proc.returncode == 0, proc.stderr
    assert proc.stdout == f"{python_abi_tag()}\n"
    assert proc.stderr == ""
