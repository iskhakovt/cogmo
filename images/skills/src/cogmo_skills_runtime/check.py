"""Register's CPython checks: `python3 -I -m cogmo_skills_runtime.check`.

Reads one `check_request` on stdin: `skill.py`, the manifest's `dependencies` and the hash of the lockfile whose venv
holds them. Writes the body to `skill.py` in a fresh temporary directory, checks it with CPython's `compile`, ruff,
pyrefly and its imports, and writes one `check_reply` line to stdout: every finding, positioned in 1-based lines and
UTF-16 columns as the register-time gates count them, with the release version the image baked beside its toolchain;
or `fatal` when a check could not run. The tools run by absolute path from the tools venv, which no task's `PATH` or
`sys.path` holds, and nothing here runs the skill's code or its dependencies' (design/skills.md → Register-time CPython
checks).
"""

import ast
import importlib.machinery
import importlib.metadata
import json
import os
import re
import subprocess
import sys
import tempfile
from collections.abc import Callable, Iterable, Mapping, Sequence
from dataclasses import dataclass
from pathlib import Path, PurePosixPath
from typing import TextIO

from cogmo_skills_runtime.supervisor import _skill_venv_path

TOOLS_VENV = "/opt/cogmo-skills/tools"
TOOLCHAIN_DIR = "/opt/cogmo-skills/toolchain"
VERSION_FILE = "/opt/cogmo-skills/VERSION"

# What a skill imports besides the stdlib and its own dependencies: the runtime the image installs for every task.
RUNTIME_ROOTS = frozenset({"pydantic", "pydantic_core", "cogmo_ctx"})

# A tool's diagnostics a failure quotes from its stderr.
_STDERR_TAIL = 2000

# Lines end where CPython, ruff and pyrefly all end them.
_NEWLINE = re.compile(r"\r\n|\r|\n")

# A `name==version` dependency's name (`SkillDependencySchema`).
_DEPENDENCY_NAME = re.compile(r"^([A-Za-z0-9](?:[A-Za-z0-9._-]*[A-Za-z0-9])?)")


@dataclass(frozen=True)
class Toolchain:
    """The tools and configuration the checks run with."""

    ruff: str
    pyrefly: str
    # The toolchain's `pyproject.toml`; its `.cogmo/` holds `cogmo_ctx`, on pyrefly's search path.
    config: str
    # The tools venv's site-packages, the last entry pyrefly resolves imports from (the runtime's pydantic).
    site_packages: str
    # The release the toolchain belongs to.
    version: str


@dataclass(frozen=True)
class Finding:
    id: str
    line: int | None
    column: int | None
    message: str

    def frame(self) -> dict[str, object]:
        return {"id": self.id, "line": self.line, "column": self.column, "message": self.message}


class CheckFailed(Exception):
    """A check could not run; the reply is `fatal`."""


def image_toolchain() -> Toolchain:
    """The toolchain the skills image bakes: the tools venv, the toolchain's files and their release version."""
    try:
        version = Path(VERSION_FILE).read_text().strip()
    except OSError as e:
        raise CheckFailed(f"the image bakes no toolchain version: {e}") from e
    if not version:
        raise CheckFailed(f"the image bakes no toolchain version: {VERSION_FILE} is empty")
    return Toolchain(
        ruff=f"{TOOLS_VENV}/bin/ruff",
        pyrefly=f"{TOOLS_VENV}/bin/pyrefly",
        config=f"{TOOLCHAIN_DIR}/pyproject.toml",
        site_packages=_site_packages(TOOLS_VENV),
        version=version,
    )


def _site_packages(venv: str) -> str:
    return os.path.join(venv, "lib", f"python{sys.version_info.major}.{sys.version_info.minor}", "site-packages")


class _Lines:
    """`skill.py`'s lines, which convert a tool's column to UTF-16 code units."""

    def __init__(self, body: str) -> None:
        self._lines = _NEWLINE.split(body)

    def _text(self, line: int) -> str:
        return self._lines[line - 1] if 1 <= line <= len(self._lines) else ""

    def from_code_points(self, line: int, column: int) -> int:
        """The UTF-16 column of 1-based code point `column`: CPython's `SyntaxError.offset`, ruff's and pyrefly's."""
        return _utf16_length(self._text(line)[: max(column - 1, 0)]) + 1

    def from_utf8(self, line: int, offset: int) -> int:
        """The UTF-16 column of 0-based UTF-8 byte `offset`, an `ast` node's `col_offset`."""
        prefix = self._text(line).encode("utf-8")[: max(offset, 0)].decode("utf-8", errors="ignore")
        return _utf16_length(prefix) + 1


def _utf16_length(text: str) -> int:
    return len(text.encode("utf-16-le")) // 2


def syntax_findings(body: str, lines: _Lines) -> list[Finding]:
    """CPython's compile of the body, which writes no bytecode and runs nothing."""
    try:
        compile(body, "skill.py", "exec", dont_inherit=True)
    except SyntaxError as e:
        if e.lineno is None:
            return [Finding("syntax", None, None, e.msg)]
        column = lines.from_code_points(e.lineno, e.offset) if e.offset else None
        return [Finding("syntax", e.lineno, column, e.msg)]
    except (RecursionError, MemoryError) as e:
        return [Finding("syntax", None, None, f"CPython could not compile it: {type(e).__name__}")]
    return []


def installed_modules(site_packages: str) -> dict[str, frozenset[str]]:
    """Each distribution in `site_packages` with the top-level modules its `RECORD` installs, by its PEP 503 name."""
    modules: dict[str, frozenset[str]] = {}
    for dist in importlib.metadata.distributions(path=[site_packages]):
        name = dist.metadata.get("Name")
        if name:
            modules[_normalized(name)] = record_modules(dist.files or [])
    return modules


def record_modules(files: Iterable[PurePosixPath]) -> frozenset[str]:
    """The top-level modules a `RECORD`'s paths install.

    A path's first segment is a module: a directory is a package, and a `.py` file, or one with an extension
    module's suffix, gives its name without the suffix. Other top-level files (`py.typed`, a license, a `.pth`),
    `*.dist-info/`, `*.data/`, `__pycache__/` and paths leaving site-packages name none.
    """
    return frozenset(module for path in files if (module := _record_module(PurePosixPath(path).parts)) is not None)


def _record_module(parts: tuple[str, ...]) -> str | None:
    if not parts or parts[0] in ("..", "/", "__pycache__"):
        return None
    first = parts[0]
    if len(parts) > 1:
        return None if first.endswith((".dist-info", ".data")) else first
    if first.endswith(".py"):
        return first.removesuffix(".py")
    suffix = next((s for s in importlib.machinery.EXTENSION_SUFFIXES if first.endswith(s)), None)
    return None if suffix is None else first.removesuffix(suffix)


def _normalized(name: str) -> str:
    return re.sub(r"[-_.]+", "-", name).lower()


def _dependency_name(spec: str) -> str:
    matched = _DEPENDENCY_NAME.match(spec)
    return _normalized(matched.group(1) if matched else spec)


def import_findings(
    tree: ast.Module,
    lines: _Lines,
    dependencies: Sequence[str],
    installed: Mapping[str, frozenset[str]],
) -> list[Finding]:
    """Every import whose root is not the stdlib, the runtime's, or a module a declared dependency installs."""
    declared = {_dependency_name(spec) for spec in dependencies}
    allowed = (
        set(sys.stdlib_module_names)
        | RUNTIME_ROOTS
        | {module for name in declared for module in installed.get(name, frozenset())}
    )
    transitive = {module: name for name, modules in installed.items() if name not in declared for module in modules}
    findings: list[Finding] = []
    for node in ast.walk(tree):
        if isinstance(node, ast.Import):
            roots = [alias.name.split(".")[0] for alias in node.names]
        elif isinstance(node, ast.ImportFrom):
            if node.level > 0:
                findings.append(_at(node, lines, "a relative import, which a skill's one module cannot resolve"))
                continue
            roots = [(node.module or "").split(".")[0]]
        else:
            continue
        for root in roots:
            if root in allowed:
                continue
            if root in transitive:
                message = (
                    f"'{root}' is installed by '{transitive[root]}', which no declared dependency names; "
                    "declare every package the skill imports"
                )
            else:
                message = (
                    f"'{root}' is not the standard library, pydantic, pydantic_core, cogmo_ctx or a module a "
                    "declared dependency installs"
                )
            findings.append(_at(node, lines, message))
    return sorted(findings, key=lambda f: (f.line or 0, f.column or 0))


def _at(node: ast.stmt, lines: _Lines, message: str) -> Finding:
    return Finding("imports", node.lineno, lines.from_utf8(node.lineno, node.col_offset), message)


def _run(argv: Sequence[str]) -> subprocess.CompletedProcess[str]:
    env = {**os.environ, "PYTHONDONTWRITEBYTECODE": "1"}
    try:
        return subprocess.run(argv, cwd="/", env=env, capture_output=True, text=True, check=False)
    except OSError as e:
        raise CheckFailed(f"{Path(argv[0]).name} did not start: {e}") from e


def _failure(tool: str, result: subprocess.CompletedProcess[str], reason: str) -> CheckFailed:
    tail = result.stderr.strip()[-_STDERR_TAIL:]
    return CheckFailed(f"{tool} {reason}" + (f": {tail}" if tail else ""))


def ruff_findings(toolchain: Toolchain, path: str, lines: _Lines) -> list[Finding]:
    """ruff with the toolchain's configuration: 0 and 1 are results, anything else a failure."""
    result = _run(
        [toolchain.ruff, "check", "--output-format", "json", "--no-cache", "--config", toolchain.config, path]
    )
    if result.returncode == 0:
        return []
    if result.returncode != 1:
        raise _failure("ruff", result, f"exited {result.returncode}")
    try:
        diagnostics = json.loads(result.stdout)
        return [
            Finding(
                "ruff",
                d["location"]["row"],
                lines.from_code_points(d["location"]["row"], d["location"]["column"]),
                f"{d['code'] or 'invalid-syntax'} {d['message']}",
            )
            for d in diagnostics
        ]
    except (ValueError, KeyError, TypeError) as e:
        raise _failure("ruff", result, f"exited 1 with output that is not its JSON ({e!r})") from e


def pyrefly_findings(toolchain: Toolchain, path: str, lines: _Lines, venv_site_packages: str | None) -> list[Finding]:
    """pyrefly against the typed `cogmo_ctx`: 0, or 1 with its JSON errors, is a result; anything else a failure.

    Imports resolve from the toolchain's search path (`.cogmo/`), then the skill's venv, then the tools venv's.
    """
    site_packages = [*([venv_site_packages] if venv_site_packages else []), toolchain.site_packages]
    result = _run(
        [
            toolchain.pyrefly,
            "check",
            "--output-format",
            "json",
            "--summary",
            "none",
            "--config",
            toolchain.config,
            "--skip-interpreter-query",
            "--disable-search-path-heuristics",
            "--python-version",
            f"{sys.version_info.major}.{sys.version_info.minor}",
            "--python-platform",
            sys.platform,
            *[arg for entry in site_packages for arg in ("--site-package-path", entry)],
            path,
        ]
    )
    if result.returncode == 0:
        return []
    if result.returncode != 1:
        raise _failure("pyrefly", result, f"exited {result.returncode}")
    try:
        errors = json.loads(result.stdout)["errors"]
        return [
            Finding(
                "pyrefly",
                e["line"],
                lines.from_code_points(e["line"], e["column"]),
                f"{e['name']} {e['concise_description']}",
            )
            for e in errors
        ]
    except (ValueError, KeyError, TypeError) as e:
        raise _failure("pyrefly", result, f"exited 1 with output that is not its JSON ({e!r})") from e


@dataclass(frozen=True)
class Request:
    """A `check_request`."""

    body: str
    dependencies: Sequence[str]
    lockfile_hash: str | None


def parse_request(text: str) -> Request:
    try:
        request = json.loads(text)
    except ValueError as e:
        raise CheckFailed(f"the request is not JSON: {e}") from e
    match request:
        case {"body": str(body), "dependencies": list(dependencies), "lockfileHash": str() | None as lockfile_hash} if (
            all(isinstance(d, str) for d in dependencies)
        ):
            return Request(body, dependencies, lockfile_hash)
        case _:
            raise CheckFailed("the request is not a check_request")


def check(request: Request, toolchain: Toolchain) -> list[Finding]:
    """Every check's findings for `request`; a `syntax` finding stands alone, since the other checks cannot read it."""
    lines = _Lines(request.body)
    syntax = syntax_findings(request.body, lines)
    if syntax:
        return syntax
    venv_site_packages = None
    installed: dict[str, frozenset[str]] = {}
    if request.lockfile_hash is not None:
        venv_site_packages = _site_packages(_skill_venv_path(request.lockfile_hash))
        if not os.path.isdir(venv_site_packages):
            raise CheckFailed(f"the skill venv has no site-packages at {venv_site_packages}")
        installed = installed_modules(venv_site_packages)
    with tempfile.TemporaryDirectory(prefix="cogmo-check-") as directory:
        path = os.path.join(directory, "skill.py")
        with open(path, "w", encoding="utf-8", newline="") as f:
            f.write(request.body)
        return [
            *ruff_findings(toolchain, path, lines),
            *pyrefly_findings(toolchain, path, lines, venv_site_packages),
            *import_findings(ast.parse(request.body, "skill.py"), lines, request.dependencies, installed),
        ]


def main(stdin: TextIO, stdout: TextIO, load_toolchain: Callable[[], Toolchain]) -> None:
    """Check the request read from `stdin` and write its one reply line to `stdout`."""
    try:
        toolchain = load_toolchain()
        findings = check(parse_request(stdin.read()), toolchain)
        reply: dict[str, object] = {
            "type": "check_findings",
            "findings": [f.frame() for f in findings],
            "toolchainVersion": toolchain.version,
        }
    except CheckFailed as e:
        reply = {"type": "fatal", "error": str(e)}
    stdout.write(json.dumps(reply) + "\n")
    stdout.flush()


if __name__ == "__main__":
    main(sys.stdin, sys.stdout, image_toolchain)
