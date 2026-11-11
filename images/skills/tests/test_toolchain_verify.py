"""`toolchain/.cogmo/verify`, the skills repo's verify command, run against a temporary skills repo.

The repo holds the toolchain as Cogmo commits it (`cogmo_ctx` joined into `.cogmo/`).
Its skills declare no dependencies unless a test gives one a lockfile of a wheel
it builds, so no check reaches the network, and the tools come from this
project's environment, first on PATH. Register's gates run under a stub `node`,
since this project has no Node: it logs each call and answers as the test says
(design/skills.md → The gates in verify).
"""

import hashlib
import importlib.metadata
import itertools
import json
import os
import shutil
import subprocess
import sys
from collections.abc import Mapping
from dataclasses import dataclass
from pathlib import Path

import pytest

from .distributions import wheel
from .pragma_cases import PRAGMAS, REFUSED, SKILL

_IMAGE = Path(__file__).parent.parent
_UNTRACKED = shutil.ignore_patterns("__pycache__", "*.py[co]", ".venv", ".ruff_cache", ".pytest_cache")
_GATES_FILES = ("gates.mjs", "web-tree-sitter.wasm", "tree-sitter-python.wasm")

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

# Logs its call, with its stdin for `--paths`, and answers with the entry `STUB_NODE_ANSWERS` holds for it, keyed
# `paths`, `gates:<skill>` or `dependencies:<skill>`; a call without one prints nothing and exits 0.
_STUB_NODE = """\
import json
import os
import sys

argv = sys.argv[1:]
call = {"argv": argv, "cwd": os.getcwd(), "NODE_OPTIONS": os.environ.get("NODE_OPTIONS")}
if "--paths" in argv:
    key = "paths"
    call["stdin"] = sys.stdin.read()
else:
    key = f"{'dependencies' if '--dependencies' in argv else 'gates'}:{argv[-1]}"
with open(os.environ["STUB_NODE_LOG"], "a") as log:
    log.write(json.dumps(call) + "\\n")
with open(os.environ["STUB_NODE_ANSWERS"]) as answers:
    answer = json.load(answers).get(key, {})
sys.stdout.write(answer.get("stdout", ""))
sys.stderr.write(answer.get("stderr", ""))
sys.stdout.flush()
if answer.get("signal"):
    os.kill(os.getpid(), answer["signal"])
sys.exit(answer.get("exit", 0))
"""


@dataclass(frozen=True)
class Gates:
    """A stub `COGMO_GATES_DIR`, and the directory holding the stub `node` with what it logs and answers."""

    dir: Path
    bin: Path
    log: Path
    answers: Path

    def answer(self, mode: str, skill: str, *, stdout: str, stderr: str, exit: int) -> None:
        self._set(f"{mode}:skills/{skill}", {"stdout": stdout, "stderr": stderr, "exit": exit})

    def answer_paths(self, *, stdout: str, stderr: str, exit: int) -> None:
        self._set("paths", {"stdout": stdout, "stderr": stderr, "exit": exit})

    def _set(self, key: str, answer: dict[str, object]) -> None:
        answers = json.loads(self.answers.read_text())
        answers[key] = answer
        self.answers.write_text(json.dumps(answers))

    def kill(self, mode: str, skill: str, signal: int) -> None:
        answers = json.loads(self.answers.read_text())
        answers[f"{mode}:skills/{skill}"] = {"signal": signal}
        self.answers.write_text(json.dumps(answers))

    def calls(self) -> list[dict[str, object]]:
        return [json.loads(line) for line in self.log.read_text().splitlines()] if self.log.exists() else []


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
    return root.resolve()


@pytest.fixture
def gates(tmp_path: Path) -> Gates:
    directory = tmp_path / "cogmo-gates"
    directory.mkdir()
    for name in _GATES_FILES:
        (directory / name).write_bytes(b"")
    stub_bin = tmp_path / "stub-bin"
    stub_bin.mkdir()
    node = stub_bin / "node"
    node.write_text(f"#!{sys.executable} -I\n{_STUB_NODE}")
    node.chmod(0o755)
    answers = tmp_path / "stub-node-answers.json"
    answers.write_text("{}")
    return Gates(directory.resolve(), stub_bin, tmp_path / "stub-node.log", answers)


def _verify(
    repo: Path, base: str | None, gates: Gates, env: Mapping[str, str | None] | None = None
) -> subprocess.CompletedProcess[str]:
    """`.cogmo/verify` in `repo`, with the stub `node` and gates directory unless `env` sets a variable or, to None,
    unsets it."""
    variables = {key: value for key, value in os.environ.items() if key not in ("COGMO_VERIFY_BASE", "NODE_OPTIONS")}
    variables["PATH"] = os.pathsep.join([str(Path(sys.executable).parent), str(gates.bin), variables.get("PATH", "")])
    variables["COGMO_GATES_DIR"] = str(gates.dir)
    variables["STUB_NODE_LOG"] = str(gates.log)
    variables["STUB_NODE_ANSWERS"] = str(gates.answers)
    if base is not None:
        variables["COGMO_VERIFY_BASE"] = base
    for key, value in (env or {}).items():
        if value is None:
            variables.pop(key, None)
        else:
            variables[key] = value
    return subprocess.run(
        [str(repo / ".cogmo" / "verify")], cwd=repo, env=variables, capture_output=True, text=True, check=False
    )


def _git_only(tmp_path: Path) -> str:
    """A `PATH` holding this project's interpreter and git, and no `node`."""
    git_only = tmp_path / "git-only"
    git_only.mkdir()
    (git_only / "git").symlink_to(shutil.which("git") or "git")
    return os.pathsep.join([str(Path(sys.executable).parent), str(git_only)])


def _headers(result: subprocess.CompletedProcess[str], name: str) -> list[str]:
    prefix = f"verify: {name}: "
    return [line.removeprefix(prefix) for line in result.stdout.splitlines() if line.startswith(prefix)]


def _paths_section(result: subprocess.CompletedProcess[str]) -> list[str]:
    """The stdout lines the path rules printed, up to the first skill's header."""
    lines = result.stdout.splitlines()
    if "verify: paths" not in lines:
        return []
    rest = lines[lines.index("verify: paths") + 1 :]
    return list(itertools.takewhile(lambda line: not line.startswith("verify: "), rest))


def _section(result: subprocess.CompletedProcess[str], name: str, label: str) -> list[str]:
    """The stdout lines check `label` printed for skill `name`, up to the next check's header; none without its own."""
    lines = result.stdout.splitlines()
    header = f"verify: {name}: {label}"
    if header not in lines:
        return []
    rest = lines[lines.index(header) + 1 :]
    return list(itertools.takewhile(lambda line: not line.startswith(f"verify: {name}: "), rest))


def test_it_fails_without_a_base(repo: Path, gates: Gates) -> None:
    result = _verify(repo, None, gates)
    assert result.returncode == 2
    assert "COGMO_VERIFY_BASE is not set" in result.stderr


def test_it_fails_on_a_base_the_repo_does_not_have(repo: Path, gates: Gates) -> None:
    result = _verify(repo, "f" * 40, gates)
    assert result.returncode == 2
    assert f"COGMO_VERIFY_BASE={'f' * 40} names no commit" in result.stderr


def test_it_passes_when_nothing_changed_without_the_gates_or_node(repo: Path, gates: Gates, tmp_path: Path) -> None:
    base = _git(repo, "rev-parse", "HEAD")
    # Ignored files are not a change.
    (repo / "skills" / "stray" / "__pycache__").mkdir(parents=True)
    (repo / "skills" / "stray" / "__pycache__" / "skill.cpython-314.pyc").write_bytes(b"\0")
    (repo / ".pytest_cache").mkdir()
    result = _verify(repo, base, gates, {"COGMO_GATES_DIR": None, "PATH": _git_only(tmp_path)})
    assert result.returncode == 0, result.stdout + result.stderr
    assert result.stdout == "verify: nothing changed\n"


@pytest.mark.parametrize("missing", ["gates", "node"])
def test_a_change_outside_skills_needs_the_gates_and_node(
    repo: Path, gates: Gates, tmp_path: Path, missing: str
) -> None:
    # Register's path rules judge it, and they run under `node`.
    base = _git(repo, "rev-parse", "HEAD")
    (repo / "README.md").write_text("notes\n")
    env = {"COGMO_GATES_DIR": None} if missing == "gates" else {"PATH": _git_only(tmp_path)}
    result = _verify(repo, base, gates, env)
    assert result.returncode == 2, result.stdout + result.stderr
    message = "COGMO_GATES_DIR is not set" if missing == "gates" else "node is not on PATH"
    assert f"verify: {message}" in result.stderr
    assert gates.calls() == []


def test_it_runs_the_path_rules_on_every_changed_path(repo: Path, gates: Gates) -> None:
    _write_skill(repo, "echo", SKILL, _PASSING_TEST)
    (repo / "notes.md").write_text("old\n")
    _git(repo, "add", "-A")
    _git(repo, "commit", "-q", "-m", "echo")
    base = _git(repo, "rev-parse", "HEAD")
    # Tracked: edited, deleted and staged; untracked and not ignored, inside and outside `skills/`; ignored: none.
    (repo / "skills" / "echo" / "test_skill.py").write_text(_FAILING_TEST)
    (repo / "notes.md").unlink()
    (repo / ".cogmo" / "paths").write_text("edited\n")
    _git(repo, "add", ".cogmo/paths")
    (repo / "skills" / "echo" / "__init__.py").write_text("")
    (repo / "scratch.txt").write_text("x\n")
    (repo / "skills" / "echo" / "__pycache__").mkdir()
    (repo / "skills" / "echo" / "__pycache__" / "skill.cpython-314.pyc").write_bytes(b"\0")
    result = _verify(repo, base, gates)
    calls = gates.calls()
    assert calls[0] == {
        "argv": ["--permission", f"--allow-fs-read={gates.dir}", str(gates.dir / "gates.mjs"), "--paths"],
        "cwd": str(repo),
        "NODE_OPTIONS": None,
        "stdin": ".cogmo/paths\0notes.md\0scratch.txt\0skills/echo/__init__.py\0skills/echo/test_skill.py\0",
    }, result.stdout + result.stderr
    assert "stdin" not in calls[1]


def test_a_path_rule_refusal_fails_verify_after_every_skills_checks(repo: Path, gates: Gates) -> None:
    base = _git(repo, "rev-parse", "HEAD")
    _write_skill(repo, "echo", SKILL, _PASSING_TEST)
    (repo / "skills" / "echo" / "__init__.py").write_text("")
    refusal = "owned_paths: skills/echo/__init__.py outside a skill's own files (skills/<name>/ with SKILL.md, ...)"
    gates.answer_paths(stdout=f"{refusal}\n", stderr="", exit=1)
    result = _verify(repo, base, gates)
    assert result.returncode == 1, result.stdout + result.stderr
    assert _paths_section(result) == [refusal]
    assert result.stdout.splitlines().index("verify: paths") < result.stdout.splitlines().index("verify: echo: gates")
    assert _headers(result, "echo") == ["gates", "suppressions", "ruff", "format", "pyrefly", "imports", "pytest"]
    assert "verify: the change failed the path rules\n" in result.stderr


@pytest.mark.parametrize(
    ("stdout", "stderr", "exit", "detail"),
    [
        ("", "gates: usage: gates.mjs [--dependencies] skills/<name>\n", 2, "gates: usage: gates.mjs"),
        # A bundle from before `--paths`, or Node's own failure before the bundle runs.
        ("", "", 1, "node exited 1 with nothing on stdout"),
    ],
)
def test_path_rules_that_could_not_run_exit_2_after_every_skills_checks(
    repo: Path, gates: Gates, stdout: str, stderr: str, exit: int, detail: str
) -> None:
    base = _git(repo, "rev-parse", "HEAD")
    _write_skill(repo, "echo", SKILL, _FAILING_TEST)
    gates.answer_paths(stdout=stdout, stderr=stderr, exit=exit)
    result = _verify(repo, base, gates)
    assert result.returncode == 2, result.stdout + result.stderr
    assert f"verify: paths: the gates could not run: {detail}" in result.stderr
    assert "verify: the change could not run the path rules\n" in result.stderr
    assert "verify: echo failed pytest\n" in result.stderr


def test_a_test_importing_the_skill_by_its_module_name_passes(repo: Path, gates: Gates) -> None:
    # pytest's prepend import mode puts the test's own directory first on `sys.path`, and pyrefly runs with it on
    # its search path, so `from skill import ...` resolves under both, as `CLAUDE.md` tells the author.
    base = _git(repo, "rev-parse", "HEAD")
    test = (
        "from typing import cast\n\nfrom cogmo_ctx import Ctx\nfrom skill import Input, Output, run\n\n\n"
        "async def test_run() -> None:\n"
        '    assert await run(Input(text="hi"), cast(Ctx, None)) == Output(text="HI")\n'
    )
    _write_skill(repo, "echo", SKILL, test)
    result = _verify(repo, base, gates)
    assert result.returncode == 0, result.stdout + result.stderr
    assert "echo passed" in result.stdout


def test_a_test_importing_the_skill_relatively_fails_pytest(repo: Path, gates: Gates) -> None:
    # A skill directory is no package: register refuses an `__init__.py` in it.
    base = _git(repo, "rev-parse", "HEAD")
    _write_skill(repo, "echo", SKILL, _PASSING_TEST.replace("from skill import", "from .skill import"))
    result = _verify(repo, base, gates)
    assert result.returncode == 1, result.stdout + result.stderr
    assert "attempted relative import with no known parent package" in result.stdout
    assert "pytest" in next(line for line in result.stderr.splitlines() if line.startswith("verify: echo failed "))


def test_it_passes_a_new_skill_and_writes_no_bytecode(repo: Path, gates: Gates) -> None:
    base = _git(repo, "rev-parse", "HEAD")
    _write_skill(repo, "echo", SKILL, _PASSING_TEST)
    result = _verify(repo, base, gates)
    assert result.returncode == 0, result.stdout + result.stderr
    assert "echo passed" in result.stdout
    assert not list((repo / "skills").rglob("__pycache__"))


def test_it_runs_the_checks_in_verifys_order(repo: Path, gates: Gates) -> None:
    base = _git(repo, "rev-parse", "HEAD")
    _write_skill(repo, "echo", SKILL, _PASSING_TEST)
    result = _verify(repo, base, gates)
    assert result.returncode == 0, result.stdout + result.stderr
    assert result.stdout.splitlines()[0] == "verify: paths"
    assert _headers(result, "echo") == ["gates", "suppressions", "ruff", "format", "pyrefly", "imports", "pytest"]


def test_it_runs_the_gates_under_the_permission_model_with_node_options_cleared(repo: Path, gates: Gates) -> None:
    base = _git(repo, "rev-parse", "HEAD")
    _write_skill(repo, "echo", SKILL, _PASSING_TEST)
    result = _verify(repo, base, gates, {"NODE_OPTIONS": "--require=/nonexistent/preload.js"})
    assert result.returncode == 0, result.stdout + result.stderr
    grants = ["--permission", f"--allow-fs-read={gates.dir}", f"--allow-fs-read={repo / 'skills' / 'echo'}"]
    bundle = str(gates.dir / "gates.mjs")
    paths = "skills/echo/skill.py\0skills/echo/test_skill.py\0"
    assert gates.calls() == [
        {"argv": [*grants[:2], bundle, "--paths"], "cwd": str(repo), "NODE_OPTIONS": None, "stdin": paths},
        {"argv": [*grants, bundle, "skills/echo"], "cwd": str(repo), "NODE_OPTIONS": None},
        {"argv": [*grants, bundle, "--dependencies", "skills/echo"], "cwd": str(repo), "NODE_OPTIONS": None},
    ]


def test_it_reports_the_gates_lines_as_findings(repo: Path, gates: Gates) -> None:
    base = _git(repo, "rev-parse", "HEAD")
    _write_skill(repo, "echo", SKILL, _PASSING_TEST)
    finding = "dynamic_code: skills/echo/skill.py:22:12: `eval` builds code at run time"
    gates.answer("gates", "echo", stdout=f"{finding}\nmissing_skill_md: skills/echo/SKILL.md\n", stderr="", exit=1)
    result = _verify(repo, base, gates)
    assert result.returncode == 1, result.stdout + result.stderr
    lines = result.stdout.splitlines()
    gates_at = lines.index("verify: echo: gates")
    assert lines[gates_at + 1 : gates_at + 3] == [finding, "missing_skill_md: skills/echo/SKILL.md"]
    assert "verify: echo failed gates\n" in result.stderr


@pytest.mark.parametrize(
    ("stdout", "stderr", "exit", "detail"),
    [
        ("", "gates: tree-sitter-python.wasm did not load\n", 2, "gates: tree-sitter-python.wasm did not load"),
        # Node's own failures, before the bundle runs or past its handlers.
        ("", "SyntaxError: Unexpected token\n", 1, "SyntaxError: Unexpected token"),
        ("", "", 1, "node exited 1 with nothing on stdout"),
        ("a line\n", "", 3, "node exited 3"),
    ],
)
def test_gates_that_could_not_run_exit_2_after_every_other_check(
    repo: Path, gates: Gates, stdout: str, stderr: str, exit: int, detail: str
) -> None:
    base = _git(repo, "rev-parse", "HEAD")
    _write_skill(repo, "echo", SKILL, _FAILING_TEST)
    gates.answer("gates", "echo", stdout=stdout, stderr=stderr, exit=exit)
    result = _verify(repo, base, gates)
    assert result.returncode == 2, result.stdout + result.stderr
    assert f"verify: echo: the gates could not run: {detail}" in result.stderr
    assert "verify: echo could not run gates\n" in result.stderr
    assert "verify: echo failed pytest\n" in result.stderr
    assert _headers(result, "echo")[-1] == "pytest"


def test_gates_killed_by_a_signal_could_not_run(repo: Path, gates: Gates) -> None:
    base = _git(repo, "rev-parse", "HEAD")
    _write_skill(repo, "echo", SKILL, _PASSING_TEST)
    gates.kill("gates", "echo", 9)
    result = _verify(repo, base, gates)
    assert result.returncode == 2, result.stdout + result.stderr
    assert "verify: echo: the gates could not run: node exited -9 with nothing on stdout" in result.stderr


def test_it_skips_imports_when_the_gates_refuse_the_manifest(repo: Path, gates: Gates) -> None:
    base = _git(repo, "rev-parse", "HEAD")
    _write_skill(
        repo,
        "echo",
        SKILL.replace("from cogmo_ctx import Ctx", "import requests\nfrom cogmo_ctx import Ctx"),
        _PASSING_TEST,
    )
    issue = "SKILL.md: tier: Invalid option"
    gates.answer("gates", "echo", stdout=f"{issue}\n", stderr="", exit=1)
    gates.answer("dependencies", "echo", stdout=f"{issue}\n", stderr="", exit=1)
    result = _verify(repo, base, gates)
    assert result.returncode == 1, result.stdout + result.stderr
    assert _section(result, "echo", "imports") == ["verify: echo skipped imports: the gates refused its SKILL.md"]
    failed = next(line for line in result.stderr.splitlines() if line.startswith("verify: echo failed "))
    assert "imports" not in failed


# Exit 2, and an exit 1 with no line, which Node gives for a failure before the bundle runs.
@pytest.mark.parametrize("exit", [2, 1])
def test_dependencies_that_could_not_be_read_exit_2(repo: Path, gates: Gates, exit: int) -> None:
    base = _git(repo, "rev-parse", "HEAD")
    _write_skill(repo, "echo", SKILL, _PASSING_TEST)
    gates.answer("dependencies", "echo", stdout="", stderr="gates: an unknown option\n", exit=exit)
    result = _verify(repo, base, gates)
    assert result.returncode == 2, result.stdout + result.stderr
    assert "verify: echo: the gates could not run: gates: an unknown option" in result.stderr
    assert "verify: echo could not run imports\n" in result.stderr


@pytest.mark.parametrize(
    ("env", "message"),
    [
        ({"COGMO_GATES_DIR": None}, "COGMO_GATES_DIR is not set"),
        ({"COGMO_GATES_DIR": "/nonexistent/cogmo-gates"}, "COGMO_GATES_DIR=/nonexistent/cogmo-gates holds no "),
    ],
)
def test_a_changed_skill_needs_the_gates_directory(
    repo: Path, gates: Gates, env: Mapping[str, str | None], message: str
) -> None:
    base = _git(repo, "rev-parse", "HEAD")
    _write_skill(repo, "echo", SKILL, _PASSING_TEST)
    result = _verify(repo, base, gates, env)
    assert result.returncode == 2, result.stdout + result.stderr
    assert f"verify: {message}" in result.stderr
    assert _headers(result, "echo") == []


def test_a_gates_directory_missing_a_file_is_unusable(repo: Path, gates: Gates) -> None:
    base = _git(repo, "rev-parse", "HEAD")
    _write_skill(repo, "echo", SKILL, _PASSING_TEST)
    (gates.dir / "tree-sitter-python.wasm").unlink()
    result = _verify(repo, base, gates)
    assert result.returncode == 2, result.stdout + result.stderr
    assert f"verify: COGMO_GATES_DIR={gates.dir} holds no tree-sitter-python.wasm" in result.stderr
    assert gates.calls() == []


def test_a_changed_skill_needs_node(repo: Path, gates: Gates, tmp_path: Path) -> None:
    base = _git(repo, "rev-parse", "HEAD")
    _write_skill(repo, "echo", SKILL, _PASSING_TEST)
    result = _verify(repo, base, gates, {"PATH": _git_only(tmp_path)})
    assert result.returncode == 2, result.stdout + result.stderr
    assert "verify: node is not on PATH" in result.stderr
    assert _headers(result, "echo") == []


# Imports two distributions the tools venv installs.
_IMPORTING = "import iniconfig\nimport pluggy\n" + SKILL.replace(
    "from cogmo_ctx import Ctx\n", "from cogmo_ctx import Ctx\n\nMODULES = (iniconfig, pluggy)\n"
)


def test_without_a_lockfile_imports_grant_only_the_stdlib_and_the_runtime(repo: Path, gates: Gates) -> None:
    # The tools venv installs both; pyrefly and pytest resolve them from it, the Imports rule does not.
    base = _git(repo, "rev-parse", "HEAD")
    _write_skill(repo, "echo", _IMPORTING, _PASSING_TEST)
    gates.answer("dependencies", "echo", stdout="iniconfig\npluggy\n", stderr="", exit=0)
    result = _verify(repo, base, gates)
    assert result.returncode == 1, result.stdout + result.stderr
    not_allowed = (
        "is not the standard library, pydantic, pydantic_core, cogmo_ctx or a module a declared dependency installs"
    )
    assert _section(result, "echo", "imports") == [
        f"skills/echo/skill.py:1:1: 'iniconfig' {not_allowed}",
        f"skills/echo/skill.py:2:1: 'pluggy' {not_allowed}",
    ]
    assert "verify: echo failed imports\n" in result.stderr


@pytest.mark.skipif(shutil.which("uv") is None, reason="needs uv")
def test_imports_read_the_lockfiles_environment_alone(repo: Path, gates: Gates, tmp_path: Path) -> None:
    # The lockfile pins `iniconfig` at the version the tools venv carries too: the environment the rule reads holds its
    # `RECORD`, so `import iniconfig` passes, and none of the tools', so `pluggy`, declared but not locked, does not.
    version = importlib.metadata.version("iniconfig")
    wheels = tmp_path / "wheels"
    wheels.mkdir()
    built = wheel(wheels, "iniconfig", version, {"iniconfig/__init__.py": "PARSED = True\n"})
    digest = hashlib.sha256(built.read_bytes()).hexdigest()
    base = _git(repo, "rev-parse", "HEAD")
    _write_skill(repo, "echo", _IMPORTING, _PASSING_TEST)
    (repo / "skills" / "echo" / "requirements.lock").write_text(
        f"iniconfig=={version} \\\n    --hash=sha256:{digest}\n"
    )
    gates.answer("dependencies", "echo", stdout="iniconfig\npluggy\n", stderr="", exit=0)
    # pyrefly and pytest run under `uv run` of the project, whose environment is this one's, as under `.cogmo/verify`'s
    # own `uv run`; the wheel is the only distribution an index offers.
    offline = {"UV_PROJECT_ENVIRONMENT": sys.prefix, "UV_NO_SYNC": "1", "UV_OFFLINE": "1", "UV_NO_INDEX": "1"}
    result = _verify(repo, base, gates, {**offline, "UV_FIND_LINKS": str(wheels)})
    assert _section(result, "echo", "imports") == [
        "skills/echo/skill.py:2:1: 'pluggy' is not the standard library, pydantic, pydantic_core, cogmo_ctx or a "
        "module a declared dependency installs"
    ], result.stdout + result.stderr
    failed = next(line for line in result.stderr.splitlines() if line.startswith("verify: echo failed "))
    assert failed == "verify: echo failed imports"


@pytest.mark.skipif(shutil.which("uv") is None, reason="needs uv")
def test_imports_fail_when_the_lockfiles_environment_is_not_built(repo: Path, gates: Gates, tmp_path: Path) -> None:
    base = _git(repo, "rev-parse", "HEAD")
    _write_skill(repo, "echo", _IMPORTING, _PASSING_TEST)
    (repo / "skills" / "echo" / "requirements.lock").write_text(f"iniconfig==99.0 \\\n    --hash=sha256:{'0' * 64}\n")
    gates.answer("dependencies", "echo", stdout="iniconfig\npluggy\n", stderr="", exit=0)
    empty = tmp_path / "no-wheels"
    empty.mkdir()
    offline = {"UV_PROJECT_ENVIRONMENT": sys.prefix, "UV_NO_SYNC": "1", "UV_OFFLINE": "1", "UV_NO_INDEX": "1"}
    result = _verify(repo, base, gates, {**offline, "UV_FIND_LINKS": str(empty)})
    assert result.returncode == 1, result.stdout + result.stderr
    # uv's account of the failure, then the refusal.
    imports = _section(result, "echo", "imports")
    assert len(imports) >= 2, result.stdout
    assert imports[0].startswith("skills/echo/requirements.lock: its environment was not built: ")
    assert imports[-1] == "skills/echo/skill.py: the Imports rule cannot read the lockfile's environment"
    failed = next(line for line in result.stderr.splitlines() if line.startswith("verify: echo failed "))
    assert "imports" in failed.split(" failed ")[1].split(", ")


def test_imports_fail_a_skill_py_the_rule_cannot_parse(repo: Path, gates: Gates) -> None:
    base = _git(repo, "rev-parse", "HEAD")
    _write_skill(repo, "echo", "def run(:\n", _PASSING_TEST)
    result = _verify(repo, base, gates)
    assert result.returncode == 1, result.stdout + result.stderr
    imports = _section(result, "echo", "imports")
    assert len(imports) == 1, result.stdout
    assert imports[0].startswith("skills/echo/skill.py: the Imports rule cannot read it: SyntaxError(")
    assert "imports" in next(line for line in result.stderr.splitlines() if " failed " in line)


def test_it_checks_a_skill_against_the_repos_cogmo_ctx(
    repo: Path, gates: Gates, tmp_path: Path, monkeypatch: pytest.MonkeyPatch
) -> None:
    # This project's environment installs its own `cogmo_ctx`. A decoy ahead of it on the interpreter's path,
    # with no `Ctx`, fails pyrefly and pytest unless each reads the repo's `.cogmo/` first.
    decoy = tmp_path / "decoy" / "cogmo_ctx"
    decoy.mkdir(parents=True)
    (decoy / "__init__.py").write_text('raise ImportError("a cogmo_ctx outside the repo\'s .cogmo/")\n')
    monkeypatch.setenv("PYTHONPATH", str(decoy.parent))
    base = _git(repo, "rev-parse", "HEAD")
    _write_skill(repo, "echo", SKILL, _PASSING_TEST)
    result = _verify(repo, base, gates)
    assert result.returncode == 0, result.stdout + result.stderr
    assert "echo passed" in result.stdout


def test_it_fails_a_skill_whose_test_fails(repo: Path, gates: Gates) -> None:
    base = _git(repo, "rev-parse", "HEAD")
    _write_skill(repo, "echo", SKILL, _FAILING_TEST)
    result = _verify(repo, base, gates)
    assert result.returncode == 1
    assert "echo failed pytest" in result.stderr


def test_it_fails_a_skill_with_a_ruff_finding(repo: Path, gates: Gates) -> None:
    base = _git(repo, "rev-parse", "HEAD")
    # BLE001 and S110: an exception swallowed into success.
    swallowing = SKILL.replace(
        "    return text.upper()",
        "    try:\n        return text.upper()\n    except Exception:\n        pass\n    return text",
    )
    _write_skill(repo, "echo", swallowing, _PASSING_TEST)
    result = _verify(repo, base, gates)
    assert result.returncode == 1
    assert "echo failed ruff" in result.stderr
    assert "BLE001" in result.stdout


@pytest.mark.parametrize("file", ["skill.py", "test_skill.py"])
def test_it_fails_a_skill_file_the_formatter_would_change(repo: Path, gates: Gates, file: str) -> None:
    base = _git(repo, "rev-parse", "HEAD")
    _write_skill(repo, "echo", SKILL, _PASSING_TEST)
    path = repo / "skills" / "echo" / file
    path.write_text(path.read_text().replace(" -> ", "->", 1))
    result = _verify(repo, base, gates)
    assert result.returncode == 1, result.stdout + result.stderr
    assert "verify: echo failed format\n" in result.stderr
    assert f"--> skills/echo/{file}:" in result.stdout


def test_it_fails_an_unused_suppression_in_either_file(repo: Path, gates: Gates) -> None:
    # ruff's RUF100 and pyrefly's `unused-ignore`; `S101` is not selected in `test_skill.py`, so its `noqa` is unused.
    base = _git(repo, "rev-parse", "HEAD")
    _write_skill(
        repo,
        "echo",
        SKILL.replace("return text.upper()", "return text.upper()  # pyrefly: ignore[bad-return]"),
        _PASSING_TEST.replace('== "HI"', '== "HI"  # noqa: S101'),
    )
    result = _verify(repo, base, gates)
    assert result.returncode == 1, result.stdout + result.stderr
    assert "verify: echo failed ruff, pyrefly\n" in result.stderr
    assert "RUF100" in result.stdout
    assert "unused-ignore" in result.stdout


def test_it_checks_a_tracked_change_and_skips_unchanged_skills(repo: Path, gates: Gates) -> None:
    _write_skill(repo, "stale", SKILL, _FAILING_TEST)
    _write_skill(repo, "echo", SKILL, _PASSING_TEST)
    _git(repo, "add", "-A")
    _git(repo, "commit", "-q", "-m", "skills")
    base = _git(repo, "rev-parse", "HEAD")
    (repo / "skills" / "echo" / "test_skill.py").write_text(_FAILING_TEST)
    result = _verify(repo, base, gates)
    assert result.returncode == 1
    assert "echo failed pytest" in result.stderr
    assert "stale" not in result.stdout + result.stderr


def test_it_fails_a_skill_file_the_suppression_rule_cannot_read(repo: Path, gates: Gates) -> None:
    base = _git(repo, "rev-parse", "HEAD")
    _write_skill(repo, "echo", SKILL, 'x = """unterminated\n')
    result = _verify(repo, base, gates)
    assert result.returncode == 1
    assert "echo failed suppressions" in result.stderr
    assert "skills/echo/test_skill.py: the suppression rule cannot read it: " in result.stdout


def test_it_refuses_the_pragmas_the_shared_table_refuses(repo: Path, gates: Gates) -> None:
    base = _git(repo, "rev-parse", "HEAD")
    for name, (body, _) in PRAGMAS.items():
        _write_skill(repo, name, body, _PASSING_TEST)

    result = _verify(repo, base, gates)

    failed = {line.split()[1] for line in result.stderr.splitlines() if " failed " in line}
    assert failed == REFUSED, result.stdout + result.stderr
