"""`toolchain/.cogmo/verify`, the skills repo's verify command, run against a temporary skills repo.

The repo holds the toolchain as Cogmo commits it (`cogmo_ctx` joined into `.cogmo/`).
Its skills declare no dependencies, so no check reaches the network, and the
tools come from this project's environment, first on PATH.
"""

import os
import shutil
import subprocess
import sys
from pathlib import Path

import pytest

_IMAGE = Path(__file__).parent.parent
_UNTRACKED = shutil.ignore_patterns("__pycache__", "*.py[co]", ".venv", ".ruff_cache", ".pytest_cache")

# The mutation image has neither, and nothing here runs `src/`, which is all it mutates.
pytestmark = pytest.mark.skipif(
    shutil.which("git") is None or not (_IMAGE / "toolchain").is_dir(),
    reason="needs git and images/skills/toolchain/",
)

_SKILL = """\
from pydantic import BaseModel

from cogmo_ctx import Ctx


class Input(BaseModel):
    text: str


class Output(BaseModel):
    text: str


def shout(text: str) -> str:
    return text.upper()


async def run(inputs: Input, ctx: Ctx) -> Output:
    return Output(text=shout(inputs.text))
"""

_PASSING_TEST = """\
from skill import Input, shout


async def test_shout() -> None:
    assert shout(Input(text="hi").text) == "HI"
"""

_FAILING_TEST = """\
from skill import shout


def test_shout() -> None:
    assert shout("hi") == "hi"
"""


def _git(repo: Path, *args: str) -> str:
    return subprocess.run(
        ["git", "-c", "user.email=t@t", "-c", "user.name=t", "-c", "commit.gpgsign=false", *args],
        cwd=repo,
        check=True,
        capture_output=True,
        text=True,
    ).stdout.strip()


def _write_skill(repo: Path, name: str, body: str, test: str) -> None:
    skill = repo / "skills" / name
    skill.mkdir(parents=True)
    (skill / "skill.py").write_text(body)
    (skill / "test_skill.py").write_text(test)


@pytest.fixture
def repo(tmp_path: Path) -> Path:
    """A skills repo whose only commit holds the toolchain."""
    root = tmp_path / "skills-repo"
    shutil.copytree(_IMAGE / "toolchain", root, ignore=_UNTRACKED)
    shutil.copytree(_IMAGE / "src" / "cogmo_ctx", root / ".cogmo" / "cogmo_ctx", ignore=_UNTRACKED)
    _git(root, "init", "-q", "-b", "main")
    _git(root, "add", "-A")
    _git(root, "commit", "-q", "-m", "toolchain")
    return root


def _verify(repo: Path, base: str | None) -> subprocess.CompletedProcess[str]:
    env = {key: value for key, value in os.environ.items() if key != "COGMO_VERIFY_BASE"}
    env["PATH"] = f"{Path(sys.executable).parent}{os.pathsep}{env.get('PATH', '')}"
    if base is not None:
        env["COGMO_VERIFY_BASE"] = base
    return subprocess.run(
        [str(repo / ".cogmo" / "verify")], cwd=repo, env=env, capture_output=True, text=True, check=False
    )


def test_it_fails_without_a_base(repo: Path) -> None:
    result = _verify(repo, None)
    assert result.returncode == 2
    assert "COGMO_VERIFY_BASE is not set" in result.stderr


def test_it_fails_on_a_base_the_repo_does_not_have(repo: Path) -> None:
    result = _verify(repo, "f" * 40)
    assert result.returncode == 2
    assert f"COGMO_VERIFY_BASE={'f' * 40} names no commit" in result.stderr


def test_it_passes_when_no_skill_changed(repo: Path) -> None:
    base = _git(repo, "rev-parse", "HEAD")
    (repo / "README.md").write_text("notes\n")
    # Ignored files under `skills/` are not a change.
    (repo / "skills" / "stray" / "__pycache__").mkdir(parents=True)
    (repo / "skills" / "stray" / "__pycache__" / "skill.cpython-314.pyc").write_bytes(b"\0")
    result = _verify(repo, base)
    assert result.returncode == 0, result.stdout + result.stderr
    assert "no skill changed" in result.stdout


def test_it_passes_a_new_skill_and_writes_no_bytecode(repo: Path) -> None:
    base = _git(repo, "rev-parse", "HEAD")
    _write_skill(repo, "echo", _SKILL, _PASSING_TEST)
    result = _verify(repo, base)
    assert result.returncode == 0, result.stdout + result.stderr
    assert "echo passed" in result.stdout
    assert not list((repo / "skills").rglob("__pycache__"))


def test_it_fails_a_skill_whose_test_fails(repo: Path) -> None:
    base = _git(repo, "rev-parse", "HEAD")
    _write_skill(repo, "echo", _SKILL, _FAILING_TEST)
    result = _verify(repo, base)
    assert result.returncode == 1
    assert "echo failed pytest" in result.stderr


def test_it_fails_a_skill_with_a_ruff_finding(repo: Path) -> None:
    base = _git(repo, "rev-parse", "HEAD")
    # BLE001 and S110: an exception swallowed into success.
    swallowing = _SKILL.replace(
        "    return text.upper()",
        "    try:\n        return text.upper()\n    except Exception:\n        pass\n    return text",
    )
    _write_skill(repo, "echo", swallowing, _PASSING_TEST)
    result = _verify(repo, base)
    assert result.returncode == 1
    assert "echo failed ruff" in result.stderr
    assert "BLE001" in result.stdout


def test_it_checks_a_tracked_change_and_skips_unchanged_skills(repo: Path) -> None:
    _write_skill(repo, "stale", _SKILL, _FAILING_TEST)
    _write_skill(repo, "echo", _SKILL, _PASSING_TEST)
    _git(repo, "add", "-A")
    _git(repo, "commit", "-q", "-m", "skills")
    base = _git(repo, "rev-parse", "HEAD")
    (repo / "skills" / "echo" / "test_skill.py").write_text(_FAILING_TEST)
    result = _verify(repo, base)
    assert result.returncode == 1
    assert "echo failed pytest" in result.stderr
    assert "stale" not in result.stdout + result.stderr
