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

from .pragma_cases import PRAGMAS, REFUSED, SKILL

_IMAGE = Path(__file__).parent.parent
_UNTRACKED = shutil.ignore_patterns("__pycache__", "*.py[co]", ".venv", ".ruff_cache", ".pytest_cache")

# The mutation image has neither, and nothing here runs `src/`, which is all it mutates.
pytestmark = pytest.mark.skipif(
    shutil.which("git") is None or not (_IMAGE / "toolchain").is_dir(),
    reason="needs git and images/skills/toolchain/",
)

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


def _headers(result: subprocess.CompletedProcess[str], name: str) -> list[str]:
    prefix = f"verify: {name}: "
    return [line.removeprefix(prefix) for line in result.stdout.splitlines() if line.startswith(prefix)]


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


def test_a_test_importing_the_skill_by_its_module_name_passes(repo: Path) -> None:
    # pytest's prepend import mode puts the test's own directory first on `sys.path`, and pyrefly runs with it on
    # its search path, so `from skill import ...` resolves under both, as `CLAUDE.md` tells the author.
    base = _git(repo, "rev-parse", "HEAD")
    test = (
        "from typing import cast\n\nfrom cogmo_ctx import Ctx\nfrom skill import Input, Output, run\n\n\n"
        "async def test_run() -> None:\n"
        '    assert await run(Input(text="hi"), cast(Ctx, None)) == Output(text="HI")\n'
    )
    _write_skill(repo, "echo", SKILL, test)
    result = _verify(repo, base)
    assert result.returncode == 0, result.stdout + result.stderr
    assert "echo passed" in result.stdout


def test_a_test_importing_the_skill_relatively_fails_pytest(repo: Path) -> None:
    # A skill directory is no package: register refuses an `__init__.py` in it.
    base = _git(repo, "rev-parse", "HEAD")
    _write_skill(repo, "echo", SKILL, _PASSING_TEST.replace("from skill import", "from .skill import"))
    result = _verify(repo, base)
    assert result.returncode == 1, result.stdout + result.stderr
    assert "attempted relative import with no known parent package" in result.stdout
    assert "pytest" in next(line for line in result.stderr.splitlines() if line.startswith("verify: echo failed "))


def test_it_passes_a_new_skill_and_writes_no_bytecode(repo: Path) -> None:
    base = _git(repo, "rev-parse", "HEAD")
    _write_skill(repo, "echo", SKILL, _PASSING_TEST)
    result = _verify(repo, base)
    assert result.returncode == 0, result.stdout + result.stderr
    assert "echo passed" in result.stdout
    assert not list((repo / "skills").rglob("__pycache__"))


def test_it_runs_the_checks_in_verifys_order(repo: Path) -> None:
    base = _git(repo, "rev-parse", "HEAD")
    _write_skill(repo, "echo", SKILL, _PASSING_TEST)
    result = _verify(repo, base)
    assert result.returncode == 0, result.stdout + result.stderr
    assert _headers(result, "echo") == ["suppressions", "ruff", "format", "pyrefly", "pytest"]


def test_it_checks_a_skill_against_the_repos_cogmo_ctx(
    repo: Path, tmp_path: Path, monkeypatch: pytest.MonkeyPatch
) -> None:
    # This project's environment installs its own `cogmo_ctx`. A decoy ahead of it on the interpreter's path,
    # with no `Ctx`, fails pyrefly and pytest unless each reads the repo's `.cogmo/` first.
    decoy = tmp_path / "decoy" / "cogmo_ctx"
    decoy.mkdir(parents=True)
    (decoy / "__init__.py").write_text('raise ImportError("a cogmo_ctx outside the repo\'s .cogmo/")\n')
    monkeypatch.setenv("PYTHONPATH", str(decoy.parent))
    base = _git(repo, "rev-parse", "HEAD")
    _write_skill(repo, "echo", SKILL, _PASSING_TEST)
    result = _verify(repo, base)
    assert result.returncode == 0, result.stdout + result.stderr
    assert "echo passed" in result.stdout


def test_it_fails_a_skill_whose_test_fails(repo: Path) -> None:
    base = _git(repo, "rev-parse", "HEAD")
    _write_skill(repo, "echo", SKILL, _FAILING_TEST)
    result = _verify(repo, base)
    assert result.returncode == 1
    assert "echo failed pytest" in result.stderr


def test_it_fails_a_skill_with_a_ruff_finding(repo: Path) -> None:
    base = _git(repo, "rev-parse", "HEAD")
    # BLE001 and S110: an exception swallowed into success.
    swallowing = SKILL.replace(
        "    return text.upper()",
        "    try:\n        return text.upper()\n    except Exception:\n        pass\n    return text",
    )
    _write_skill(repo, "echo", swallowing, _PASSING_TEST)
    result = _verify(repo, base)
    assert result.returncode == 1
    assert "echo failed ruff" in result.stderr
    assert "BLE001" in result.stdout


@pytest.mark.parametrize("file", ["skill.py", "test_skill.py"])
def test_it_fails_a_skill_file_the_formatter_would_change(repo: Path, file: str) -> None:
    base = _git(repo, "rev-parse", "HEAD")
    _write_skill(repo, "echo", SKILL, _PASSING_TEST)
    path = repo / "skills" / "echo" / file
    path.write_text(path.read_text().replace(" -> ", "->", 1))
    result = _verify(repo, base)
    assert result.returncode == 1, result.stdout + result.stderr
    assert "verify: echo failed format\n" in result.stderr
    assert f"--> skills/echo/{file}:" in result.stdout


def test_a_skill_without_its_python_files_skips_the_formatter(repo: Path) -> None:
    # `ruff format --check` given no file would check the whole repo.
    base = _git(repo, "rev-parse", "HEAD")
    (repo / "skills" / "echo").mkdir(parents=True)
    (repo / "skills" / "echo" / "SKILL.md").write_text("---\nname: echo\n---\n")
    result = _verify(repo, base)
    assert _headers(result, "echo") == ["suppressions", "ruff", "pyrefly", "pytest"], result.stdout + result.stderr


def test_it_fails_an_unused_suppression_in_either_file(repo: Path) -> None:
    # ruff's RUF100 and pyrefly's `unused-ignore`; `S101` is not selected in `test_skill.py`, so its `noqa` is unused.
    base = _git(repo, "rev-parse", "HEAD")
    _write_skill(
        repo,
        "echo",
        SKILL.replace("return text.upper()", "return text.upper()  # pyrefly: ignore[bad-return]"),
        _PASSING_TEST.replace('== "HI"', '== "HI"  # noqa: S101'),
    )
    result = _verify(repo, base)
    assert result.returncode == 1, result.stdout + result.stderr
    assert "verify: echo failed ruff, pyrefly\n" in result.stderr
    assert "RUF100" in result.stdout
    assert "unused-ignore" in result.stdout


def test_it_checks_a_tracked_change_and_skips_unchanged_skills(repo: Path) -> None:
    _write_skill(repo, "stale", SKILL, _FAILING_TEST)
    _write_skill(repo, "echo", SKILL, _PASSING_TEST)
    _git(repo, "add", "-A")
    _git(repo, "commit", "-q", "-m", "skills")
    base = _git(repo, "rev-parse", "HEAD")
    (repo / "skills" / "echo" / "test_skill.py").write_text(_FAILING_TEST)
    result = _verify(repo, base)
    assert result.returncode == 1
    assert "echo failed pytest" in result.stderr
    assert "stale" not in result.stdout + result.stderr


def test_it_fails_a_skill_file_the_suppression_rule_cannot_read(repo: Path) -> None:
    base = _git(repo, "rev-parse", "HEAD")
    _write_skill(repo, "echo", SKILL, 'x = """unterminated\n')
    result = _verify(repo, base)
    assert result.returncode == 1
    assert "echo failed suppressions" in result.stderr
    assert "skills/echo/test_skill.py: the suppression rule cannot read it: " in result.stdout


def test_it_refuses_the_pragmas_the_shared_table_refuses(repo: Path) -> None:
    base = _git(repo, "rev-parse", "HEAD")
    for name, (body, _) in PRAGMAS.items():
        _write_skill(repo, name, body, _PASSING_TEST)

    result = _verify(repo, base)

    failed = {line.split()[1] for line in result.stderr.splitlines() if " failed " in line}
    assert failed == REFUSED, result.stdout + result.stderr
