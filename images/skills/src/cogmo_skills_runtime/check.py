"""Register's CPython checks: `python3 -I -m cogmo_skills_runtime.check`.

Reads one `check_request` on stdin: `skill.py`, the manifest's `dependencies` and the hash of the lockfile whose venv
holds them. Writes the body to `skill.py` in a fresh temporary directory, checks it with CPython's `compile`, ruff,
pyrefly, its imports and the toolchain's suppression rule, and writes one `check_reply` line to stdout: every finding,
positioned in 1-based lines and UTF-16 columns as the register-time gates count them, and every suppression the body
carries, with the release version the image baked beside its toolchain; or `fatal` when a check could not run. The
tools run by absolute path from the tools venv, which no task's `PATH` or `sys.path` holds, and nothing here runs the
skill's code or its dependencies' (design/skills.md → Register-time CPython checks).
"""

import ast
import importlib.machinery
import importlib.metadata
import importlib.util
import json
import os
import re
import subprocess
import sys
import tempfile
import tokenize
from collections import Counter
from collections.abc import Callable, Iterable, Mapping, Sequence
from dataclasses import dataclass, replace
from pathlib import Path, PurePosixPath
from types import ModuleType
from typing import TextIO

from cogmo_skills_runtime.supervisor import _skill_venv_path

TOOLS_VENV = "/opt/cogmo-skills/tools"
TOOLCHAIN_DIR = "/opt/cogmo-skills/toolchain"
VERSION_FILE = "/opt/cogmo-skills/VERSION"

# What a skill imports besides the stdlib and its own dependencies: the runtime the image installs for every task.
RUNTIME_ROOTS = frozenset({"pydantic", "pydantic_core", "cogmo_ctx"})

# A tool's diagnostics a failure quotes from its stderr.
_STDERR_TAIL = 2000

# The findings a reply carries, and the code points of each message.
MAX_FINDINGS = 100
MAX_MESSAGE = 400

# Lines end where CPython, ruff and pyrefly all end them.
_NEWLINE = re.compile(r"\r\n|\r|\n")

# A `name==version` dependency's name (`SkillDependencySchema`).
_DEPENDENCY_NAME = re.compile(r"^([A-Za-z0-9](?:[A-Za-z0-9._-]*[A-Za-z0-9])?)")


@dataclass(frozen=True)
class Toolchain:
    """The tools and configuration the checks run with."""

    ruff: str
    pyrefly: str
    # The toolchain's `pyproject.toml`. Its `.cogmo/` holds `cogmo_ctx`, on pyrefly's search path, and
    # `suppressions.py`, the suppression rule `.cogmo/verify` applies too.
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


def compiled(body: str, lines: _Lines) -> ast.Module | Finding:
    """The body's tree once CPython compiles it, writing no bytecode and running nothing; or its `syntax` finding.

    The parse runs first, since its errors count their column in code points; the compile of its tree raises the
    compiler's and the symbol table's, which count it in UTF-8 bytes.
    """
    try:
        tree = ast.parse(body, "skill.py")
    except SyntaxError as e:
        return _syntax(e, lines.from_code_points)
    except (RecursionError, MemoryError) as e:
        return _uncompilable(e)
    try:
        compile(tree, "skill.py", "exec", dont_inherit=True)
    except SyntaxError as e:
        return _syntax(e, lambda line, offset: lines.from_utf8(line, offset - 1))
    except (RecursionError, MemoryError) as e:
        return _uncompilable(e)
    return tree


def _syntax(e: SyntaxError, column: Callable[[int, int], int]) -> Finding:
    if e.lineno is None:
        return Finding("syntax", None, None, e.msg)
    return Finding("syntax", e.lineno, column(e.lineno, e.offset) if e.offset else None, e.msg)


def _uncompilable(e: RecursionError | MemoryError) -> Finding:
    return Finding("syntax", None, None, f"CPython could not compile it: {type(e).__name__}")


def installed_modules(site_packages: str) -> dict[str, frozenset[str]]:
    """Each distribution in `site_packages` with the modules its `RECORD` installs, by its PEP 503 name."""
    return record_modules(
        {
            _normalized(name): dist.files or []
            for dist in importlib.metadata.distributions(path=[site_packages])
            if (name := dist.metadata.get("Name"))
        }
    )


def record_modules(records: Mapping[str, Iterable[PurePosixPath]]) -> dict[str, frozenset[str]]:
    """The modules each of one site-packages' `RECORD`s installs, keyed as `records` keys them.

    A path names the first directory along it that is the distribution's package, one whose `__init__` its `RECORD`
    alone installs; otherwise the module its file is: a `.py` file, or one with an extension module's suffix, without
    the suffix, and an `__init__` its directory. So a directory whose `__init__` no `RECORD` installs (PEP 420), or
    several do (pkgutil-style), is a namespace each distribution's modules sit beneath. Other files (`py.typed`, a
    license, a `.pth`), `*.dist-info/`, `*.data/`, `__pycache__/`, paths leaving site-packages, and names that are not
    identifiers name none.
    """
    paths = {
        name: [parts for path in files if (parts := _record_parts(PurePosixPath(path))) is not None]
        for name, files in records.items()
    }
    init_owners: dict[tuple[str, ...], set[str]] = {}
    for name, name_paths in paths.items():
        for parts in name_paths:
            if _module_name(parts[-1]) == "__init__":
                init_owners.setdefault(parts[:-1], set()).add(name)
    return {
        name: frozenset(
            module for parts in name_paths if (module := _record_module(parts, {name}, init_owners)) is not None
        )
        for name, name_paths in paths.items()
    }


def _record_parts(path: PurePosixPath) -> tuple[str, ...] | None:
    parts = path.parts
    if not parts or parts[0] in ("..", "/") or parts[0].endswith((".dist-info", ".data")) or "__pycache__" in parts:
        return None
    return parts


def _record_module(
    parts: tuple[str, ...], installer: set[str], init_owners: Mapping[tuple[str, ...], set[str]]
) -> str | None:
    package = next(
        (parts[:depth] for depth in range(1, len(parts)) if init_owners.get(parts[:depth]) == installer), None
    )
    if package is not None:
        segments = package
    else:
        module = _module_name(parts[-1])
        if module is None:
            return None
        segments = parts[:-1] if module == "__init__" else (*parts[:-1], module)
    return ".".join(segments) if segments and all(segment.isidentifier() for segment in segments) else None


def _module_name(file: str) -> str | None:
    if file.endswith(".py"):
        return file.removesuffix(".py")
    suffix = next((s for s in importlib.machinery.EXTENSION_SUFFIXES if file.endswith(s)), None)
    return None if suffix is None else file.removesuffix(suffix)


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
    """Every import the stdlib, the runtime and the modules a declared dependency installs do not cover.

    `import a.b` imports `a.b`, and `from a.b import c` imports `a.b.c`, a submodule or a name in `a.b`. The
    distributions that install it are those installing its deepest prefix that some distribution installs, or, for a
    namespace, every one installing a module beneath it.
    """
    declared = frozenset(_dependency_name(spec) for spec in dependencies)
    installers: dict[str, set[str]] = {}
    for name, modules in installed.items():
        for module in modules:
            installers.setdefault(module, set()).add(name)
    findings: list[Finding] = []
    for node in ast.walk(tree):
        if isinstance(node, ast.Import):
            imported = [alias.name for alias in node.names]
        elif isinstance(node, ast.ImportFrom):
            if node.level > 0:
                findings.append(_at(node, lines, "a relative import, which a skill's one module cannot resolve"))
                continue
            module = node.module or ""
            imported = [module if alias.name == "*" else f"{module}.{alias.name}" for alias in node.names]
        else:
            continue
        refusals = (_import_refusal(name, declared, installers) for name in imported)
        findings.extend(_at(node, lines, message) for message in dict.fromkeys(r for r in refusals if r is not None))
    return sorted(findings, key=lambda f: (f.line or 0, f.column or 0))


def _import_refusal(name: str, declared: frozenset[str], installers: Mapping[str, set[str]]) -> str | None:
    root = name.split(".")[0]
    if root in sys.stdlib_module_names or root in RUNTIME_ROOTS:
        return None
    installed = _installed_as(name, installers)
    if installed is None:
        return (
            f"'{root}' is not the standard library, pydantic, pydantic_core, cogmo_ctx or a module a declared "
            "dependency installs"
        )
    module, names = installed
    if names & declared:
        return None
    return (
        f"'{module}' is installed by {', '.join(f"'{n}'" for n in sorted(names))}, which no declared dependency "
        "names; declare every package the skill imports"
    )


def _installed_as(name: str, installers: Mapping[str, set[str]]) -> tuple[str, set[str]] | None:
    """The module `name` imports as installed, with the distributions installing it; None when none installs it."""
    parts = name.split(".")
    for depth in range(len(parts), 0, -1):
        prefix = ".".join(parts[:depth])
        if prefix in installers:
            return prefix, installers[prefix]
    beneath = {n for module, names in installers.items() if module.startswith(f"{name}.") for n in names}
    return (name, beneath) if beneath else None


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


def suppression_findings(
    toolchain: Toolchain, body: str, lines: _Lines
) -> tuple[list[Finding], list[dict[str, object]]]:
    """The toolchain's suppression rule over the body: a finding per pragma it refuses, and each suppression's frame."""
    rule = _suppression_rule(Path(toolchain.config).parent / ".cogmo" / "suppressions.py")
    try:
        scanned = rule.scan(body)
    except (SyntaxError, tokenize.TokenError) as e:
        raise CheckFailed(f"the suppression rule could not read the body: {e}") from e
    return (
        [Finding("suppression", r.line, lines.from_code_points(r.line, r.column), r.message) for r in scanned.refusals],
        [{"tool": s.tool, "code": s.code, "line": s.line} for s in scanned.suppressions],
    )


def _suppression_rule(path: Path) -> ModuleType:
    spec = importlib.util.spec_from_file_location("cogmo_toolchain_suppressions", path)
    if spec is None or spec.loader is None:
        raise CheckFailed(f"the toolchain has no suppression rule at {path}")
    rule = importlib.util.module_from_spec(spec)
    # `-I` ignores PYTHONDONTWRITEBYTECODE, and the toolchain's directory is the image's.
    sys.dont_write_bytecode = True
    try:
        spec.loader.exec_module(rule)
    except (OSError, SyntaxError) as e:
        raise CheckFailed(f"the toolchain's suppression rule did not load: {e}") from e
    return rule


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


@dataclass(frozen=True)
class Checked:
    """Every check's findings, and the frame of each suppression the body carries."""

    findings: list[Finding]
    suppressions: list[dict[str, object]]


def check(request: Request, toolchain: Toolchain) -> Checked:
    """Every check's findings for `request`; a `syntax` finding stands alone, since the other checks cannot read it."""
    lines = _Lines(request.body)
    tree = compiled(request.body, lines)
    if isinstance(tree, Finding):
        return Checked([tree], [])
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
        refused, suppressions = suppression_findings(toolchain, request.body, lines)
        findings = [
            *ruff_findings(toolchain, path, lines),
            *pyrefly_findings(toolchain, path, lines, venv_site_packages),
            *import_findings(tree, lines, request.dependencies, installed),
            *refused,
        ]
    return Checked(findings, suppressions)


def bounded(findings: Sequence[Finding]) -> list[Finding]:
    """The first `MAX_FINDINGS` findings, each message cut to `MAX_MESSAGE` code points, then one finding per check
    counting what it found past them, so a reply stays far below the 1 MiB the host reads of it."""
    kept = [replace(f, message=_cut(f.message)) for f in findings[:MAX_FINDINGS]]
    left_out = Counter(f.id for f in findings[MAX_FINDINGS:])
    return [
        *kept,
        *(Finding(check_id, None, None, f"and {n} more {check_id} findings") for check_id, n in left_out.items()),
    ]


def _cut(message: str) -> str:
    return message if len(message) <= MAX_MESSAGE else f"{message[: MAX_MESSAGE - 1]}…"


def main(stdin: TextIO, stdout: TextIO, load_toolchain: Callable[[], Toolchain]) -> None:
    """Check the request read from `stdin` and write its one reply line to `stdout`."""
    try:
        toolchain = load_toolchain()
        checked = check(parse_request(stdin.read()), toolchain)
        reply: dict[str, object] = {
            "type": "check_findings",
            "findings": [f.frame() for f in bounded(checked.findings)],
            "suppressions": checked.suppressions,
            "toolchainVersion": toolchain.version,
        }
    except CheckFailed as e:
        reply = {"type": "fatal", "error": str(e)}
    stdout.write(json.dumps(reply) + "\n")
    stdout.flush()


if __name__ == "__main__":
    main(sys.stdin, sys.stdout, image_toolchain)
