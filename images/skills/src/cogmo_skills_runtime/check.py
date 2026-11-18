"""Register's CPython checks: `python3 -I -m cogmo_skills_runtime.check`.

Reads one `check_request` on stdin: `skill.py`, the manifest's `dependencies` and the hash of the lockfile whose venv
holds them. Writes the body to `skill.py` in a fresh temporary directory, checks it with CPython's `compile`, ruff,
`ruff format`, pyrefly, and the toolchain's Imports and suppression rules, and writes one `check_reply` line to stdout:
every finding, positioned in 1-based lines and UTF-16 columns as the register-time gates count them, and every
suppression the body carries, with the release version the image baked beside its toolchain; or `fatal` when a check
could not run. The tools run by absolute path from the tools venv, which no task's `PATH` or `sys.path` holds, and
nothing here runs the skill's code or its dependencies' (design/skills.md → Register-time CPython checks).
"""

import ast
import importlib.util
import json
import os
import re
import subprocess
import sys
import tempfile
import tokenize
from collections import Counter
from collections.abc import Callable, Sequence
from dataclasses import dataclass, replace
from pathlib import Path
from types import ModuleType
from typing import TextIO

from cogmo_skills_runtime.supervisor import _skill_venv_path

TOOLS_VENV = "/opt/cogmo-skills/tools"
TOOLCHAIN_DIR = "/opt/cogmo-skills/toolchain"
VERSION_FILE = "/opt/cogmo-skills/VERSION"

# A tool's diagnostics a failure quotes from its stderr.
_STDERR_TAIL = 2000

# The findings a reply carries, and the code points of each message.
MAX_FINDINGS = 100
MAX_MESSAGE = 400

# Lines end where CPython, ruff and pyrefly all end them.
_NEWLINE = re.compile(r"\r\n|\r|\n")

# What a `format` finding tells the author to run on the file its prefix names.
_FORMAT_FIX = "`uv run ruff format` on it"


@dataclass(frozen=True)
class Toolchain:
    """The tools and configuration the checks run with."""

    ruff: str
    pyrefly: str
    # The toolchain's `pyproject.toml`. Its `.cogmo/` holds `cogmo_ctx`, on pyrefly's search path, `suppressions.py`,
    # the suppression rule `.cogmo/verify` applies too, and `imports.py`, the Imports rule.
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


def syntax_finding(body: str, lines: _Lines) -> Finding | None:
    """The body's `syntax` finding when CPython does not compile it, writing no bytecode and running nothing.

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
    return None


def _syntax(e: SyntaxError, column: Callable[[int, int], int]) -> Finding:
    if e.lineno is None:
        return Finding("syntax", None, None, e.msg)
    return Finding("syntax", e.lineno, column(e.lineno, e.offset) if e.offset else None, e.msg)


def _uncompilable(e: RecursionError | MemoryError) -> Finding:
    return Finding("syntax", None, None, f"CPython could not compile it: {type(e).__name__}")


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


def format_findings(toolchain: Toolchain, path: str, lines: _Lines) -> list[Finding]:
    """`ruff format --check` with the toolchain's configuration: one finding at the first difference from the
    formatter's layout. 0, or 1 with its JSON diagnostic, is a result; anything else a failure."""
    result = _run(
        [
            toolchain.ruff,
            "format",
            "--check",
            "--output-format",
            "json",
            "--no-cache",
            "--config",
            toolchain.config,
            path,
        ]
    )
    if result.returncode == 0:
        return []
    if result.returncode != 1:
        raise _failure("ruff format", result, f"exited {result.returncode}")
    try:
        findings = [
            Finding(
                "format",
                d["location"]["row"],
                lines.from_code_points(d["location"]["row"], d["location"]["column"]),
                f"{d['code']} {d['message']}: run {_FORMAT_FIX}",
            )
            for d in json.loads(result.stdout)
        ]
    except (ValueError, KeyError, TypeError) as e:
        raise _failure("ruff format", result, f"exited 1 with output that is not its JSON ({e!r})") from e
    if not findings:
        raise _failure("ruff format", result, "exited 1 with no diagnostic")
    return findings


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


def suppression_findings(rule: ModuleType, body: str, lines: _Lines) -> tuple[list[Finding], list[dict[str, object]]]:
    """The suppression rule over the body: a finding per pragma it refuses, and each suppression's frame."""
    try:
        scanned = rule.scan(body)
    except (SyntaxError, tokenize.TokenError) as e:
        raise CheckFailed(f"the suppression rule could not read the body: {e}") from e
    return (
        [Finding("suppression", r.line, lines.from_code_points(r.line, r.column), r.message) for r in scanned.refusals],
        [{"tool": s.tool, "code": s.code, "line": s.line} for s in scanned.suppressions],
    )


def import_findings(
    rule: ModuleType, body: str, lines: _Lines, dependencies: Sequence[str], venv_site_packages: str | None
) -> list[Finding]:
    """The Imports rule over the body, against the modules the skill venv's `RECORD`s list; none without a venv."""
    installed = {} if venv_site_packages is None else rule.installed_modules(venv_site_packages)
    try:
        refusals = rule.scan(body, dependencies, installed)
    except (SyntaxError, RecursionError, MemoryError) as e:
        raise CheckFailed(f"the Imports rule could not read the body: {e!r}") from e
    return [Finding("imports", r.line, lines.from_code_points(r.line, r.column), r.message) for r in refusals]


def toolchain_rule(toolchain: Toolchain, name: str, label: str) -> ModuleType:
    """The toolchain's rule `.cogmo/<name>.py`, loaded by path."""
    path = Path(toolchain.config).parent / ".cogmo" / f"{name}.py"
    spec = importlib.util.spec_from_file_location(f"cogmo_toolchain_{name}", path)
    if spec is None or spec.loader is None:
        raise CheckFailed(f"the toolchain has no {label} rule at {path}")
    rule = importlib.util.module_from_spec(spec)
    # `-I` ignores PYTHONDONTWRITEBYTECODE, and the toolchain's directory is the image's.
    sys.dont_write_bytecode = True
    try:
        spec.loader.exec_module(rule)
    except (OSError, SyntaxError) as e:
        raise CheckFailed(f"the toolchain's {label} rule did not load: {e}") from e
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
    syntax = syntax_finding(request.body, lines)
    if syntax is not None:
        return Checked([syntax], [])
    venv_site_packages = None
    if request.lockfile_hash is not None:
        venv_site_packages = _site_packages(_skill_venv_path(request.lockfile_hash))
        if not os.path.isdir(venv_site_packages):
            raise CheckFailed(f"the skill venv has no site-packages at {venv_site_packages}")
    suppression_rule = toolchain_rule(toolchain, "suppressions", "suppression")
    imports_rule = toolchain_rule(toolchain, "imports", "Imports")
    with tempfile.TemporaryDirectory(prefix="cogmo-check-") as directory:
        path = os.path.join(directory, "skill.py")
        with open(path, "w", encoding="utf-8", newline="") as f:
            f.write(request.body)
        refused, suppressions = suppression_findings(suppression_rule, request.body, lines)
        findings = [
            *ruff_findings(toolchain, path, lines),
            *format_findings(toolchain, path, lines),
            *pyrefly_findings(toolchain, path, lines, venv_site_packages),
            *import_findings(imports_rule, request.body, lines, request.dependencies, venv_site_packages),
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
