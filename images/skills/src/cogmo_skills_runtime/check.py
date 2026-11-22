"""Register's CPython checks: `python3 -I -m cogmo_skills_runtime.check`.

Reads one `check_request` on stdin: `skill.py`, `test_skill.py` or null (absent from an older host), the manifest's
`dependencies` and the hash of the lockfile whose venv holds them. Writes the files to a fresh temporary directory,
checks them with CPython's `compile`, ruff, `ruff format`, pyrefly, and the toolchain's Imports and suppression rules,
and writes one `check_reply` line to stdout: every finding, naming its file and positioned in 1-based lines and UTF-16
columns as the register-time gates count them, and every suppression `skill.py` carries, with the release version the
image baked beside its toolchain and `testRunner`, which tells the host the image runs a skill's tests; or `fatal` when
a check could not run. The tools run by absolute path
from the tools venv, which no task's `PATH` or `sys.path` holds, and nothing here runs the skill's code or its
dependencies' (design/skills.md → Register-time CPython checks).
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
from collections.abc import Callable, Mapping, Sequence
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

SKILL_FILE = "skill.py"
TEST_FILE = "test_skill.py"


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
    # `skill.py` or `test_skill.py`.
    file: str
    line: int | None
    column: int | None
    message: str

    def frame(self) -> dict[str, object]:
        return {"id": self.id, "file": self.file, "line": self.line, "column": self.column, "message": self.message}


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
    """A file's lines, which convert a tool's column to UTF-16 code units."""

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


def syntax_finding(file: str, body: str, lines: _Lines) -> Finding | None:
    """The `syntax` finding of `file`'s body when CPython does not compile it, writing no bytecode and running nothing.

    The parse runs first, since its errors count their column in code points; the compile of its tree raises the
    compiler's and the symbol table's, which count it in UTF-8 bytes.
    """
    try:
        tree = ast.parse(body, file)
    except SyntaxError as e:
        return _syntax(file, e, lines.from_code_points)
    except (RecursionError, MemoryError) as e:
        return _uncompilable(file, e)
    try:
        compile(tree, file, "exec", dont_inherit=True)
    except SyntaxError as e:
        return _syntax(file, e, lambda line, offset: lines.from_utf8(line, offset - 1))
    except (RecursionError, MemoryError) as e:
        return _uncompilable(file, e)
    return None


def _syntax(file: str, e: SyntaxError, column: Callable[[int, int], int]) -> Finding:
    if e.lineno is None:
        return Finding("syntax", file, None, None, e.msg)
    return Finding("syntax", file, e.lineno, column(e.lineno, e.offset) if e.offset else None, e.msg)


def _uncompilable(file: str, e: RecursionError | MemoryError) -> Finding:
    return Finding("syntax", file, None, None, f"CPython could not compile it: {type(e).__name__}")


def _run(argv: Sequence[str]) -> subprocess.CompletedProcess[str]:
    env = {**os.environ, "PYTHONDONTWRITEBYTECODE": "1"}
    try:
        return subprocess.run(argv, cwd="/", env=env, capture_output=True, text=True, check=False)
    except OSError as e:
        raise CheckFailed(f"{Path(argv[0]).name} did not start: {e}") from e


def _failure(tool: str, result: subprocess.CompletedProcess[str], reason: str) -> CheckFailed:
    tail = result.stderr.strip()[-_STDERR_TAIL:]
    return CheckFailed(f"{tool} {reason}" + (f": {tail}" if tail else ""))


class _Files:
    """The files the checks read, written to one directory, and each one's lines by its name."""

    def __init__(self, directory: str, lines: Mapping[str, _Lines]) -> None:
        self.directory = directory
        self.lines = lines

    def paths(self) -> list[str]:
        return [os.path.join(self.directory, file) for file in self.lines]

    def at(self, check_id: str, path: str, line: int, column: int, message: str) -> Finding:
        """A tool's finding in the file at `path`, its 1-based code point `column` as UTF-16 code units.

        Raises `CheckFailed` when `path` names neither file the tool was given.
        """
        file = Path(path).name
        if file not in self.lines:
            raise CheckFailed(f"{check_id} reported a finding in {path}, a file it was not given")
        return Finding(check_id, file, line, self.lines[file].from_code_points(line, column), message)


def ruff_findings(toolchain: Toolchain, files: _Files) -> list[Finding]:
    """ruff with the toolchain's configuration: 0 and 1 are results, anything else a failure."""
    result = _run(
        [toolchain.ruff, "check", "--output-format", "json", "--no-cache", "--config", toolchain.config, *files.paths()]
    )
    if result.returncode == 0:
        return []
    if result.returncode != 1:
        raise _failure("ruff", result, f"exited {result.returncode}")
    try:
        diagnostics = json.loads(result.stdout)
        return [
            files.at(
                "ruff",
                d["filename"],
                d["location"]["row"],
                d["location"]["column"],
                f"{d['code'] or 'invalid-syntax'} {d['message']}",
            )
            for d in diagnostics
        ]
    except (ValueError, KeyError, TypeError) as e:
        raise _failure("ruff", result, f"exited 1 with output that is not its JSON ({e!r})") from e


def format_findings(toolchain: Toolchain, files: _Files) -> list[Finding]:
    """`ruff format --check` with the toolchain's configuration: per file, one finding at the first difference from
    the formatter's layout. 0, or 1 with its JSON diagnostics, is a result; anything else a failure."""
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
            *files.paths(),
        ]
    )
    if result.returncode == 0:
        return []
    if result.returncode != 1:
        raise _failure("ruff format", result, f"exited {result.returncode}")
    try:
        findings = [
            files.at(
                "format",
                d["filename"],
                d["location"]["row"],
                d["location"]["column"],
                f"{d['code']} {d['message']}: run {_FORMAT_FIX}",
            )
            for d in json.loads(result.stdout)
        ]
    except (ValueError, KeyError, TypeError) as e:
        raise _failure("ruff format", result, f"exited 1 with output that is not its JSON ({e!r})") from e
    if not findings:
        raise _failure("ruff format", result, "exited 1 with no diagnostic")
    return findings


def pyrefly_findings(toolchain: Toolchain, files: _Files, venv_site_packages: str | None) -> list[Finding]:
    """pyrefly against the typed `cogmo_ctx`: 0, or 1 with its JSON errors, is a result; anything else a failure.

    Imports resolve from the files' directory, so `test_skill.py` reads `skill`, and the toolchain's search path
    (`.cogmo/`), then the skill's venv, then the tools venv's.
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
            "--search-path",
            files.directory,
            *[arg for entry in site_packages for arg in ("--site-package-path", entry)],
            *files.paths(),
        ]
    )
    if result.returncode == 0:
        return []
    if result.returncode != 1:
        raise _failure("pyrefly", result, f"exited {result.returncode}")
    try:
        errors = json.loads(result.stdout)["errors"]
        return [
            files.at("pyrefly", e["path"], e["line"], e["column"], f"{e['name']} {e['concise_description']}")
            for e in errors
        ]
    except (ValueError, KeyError, TypeError) as e:
        raise _failure("pyrefly", result, f"exited 1 with output that is not its JSON ({e!r})") from e


def suppression_findings(
    rule: ModuleType, file: str, body: str, lines: _Lines
) -> tuple[list[Finding], list[dict[str, object]]]:
    """The suppression rule over `file`'s body: a finding per pragma it refuses, and each suppression's frame."""
    try:
        scanned = rule.scan(body)
    except (SyntaxError, tokenize.TokenError) as e:
        raise CheckFailed(f"the suppression rule could not read {file}: {e}") from e
    return (
        [
            Finding("suppression", file, r.line, lines.from_code_points(r.line, r.column), r.message)
            for r in scanned.refusals
        ],
        [{"tool": s.tool, "code": s.code, "line": s.line} for s in scanned.suppressions],
    )


def import_findings(
    rule: ModuleType,
    file: str,
    body: str,
    lines: _Lines,
    dependencies: Sequence[str],
    installed: Mapping[str, frozenset[str]],
) -> list[Finding]:
    """The Imports rule over `file`'s body, against the modules the skill venv's `RECORD`s list (`installed`)."""
    try:
        refusals = rule.scan(body, file, dependencies, installed)
    except (SyntaxError, RecursionError, MemoryError) as e:
        raise CheckFailed(f"the Imports rule could not read {file}: {e!r}") from e
    return [Finding("imports", file, r.line, lines.from_code_points(r.line, r.column), r.message) for r in refusals]


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
    # `test_skill.py`; None without one.
    test_body: str | None
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
            and isinstance(test_body := request.get("testBody"), str | None)
        ):
            return Request(body, test_body, dependencies, lockfile_hash)
        case _:
            raise CheckFailed("the request is not a check_request")


@dataclass(frozen=True)
class Checked:
    """Every check's findings, and the frame of each suppression `skill.py` carries."""

    findings: list[Finding]
    suppressions: list[dict[str, object]]


def check(request: Request, toolchain: Toolchain) -> Checked:
    """Every check's findings for `request`'s files; `syntax` findings stand alone, since the other checks cannot read
    a file CPython refuses. A test's suppressions cover no code a deploy runs, so only `skill.py`'s are kept."""
    bodies = {SKILL_FILE: request.body, **({} if request.test_body is None else {TEST_FILE: request.test_body})}
    lines = {file: _Lines(body) for file, body in bodies.items()}
    syntax = [f for file, body in bodies.items() if (f := syntax_finding(file, body, lines[file])) is not None]
    if syntax:
        return Checked(syntax, [])
    venv_site_packages = None
    if request.lockfile_hash is not None:
        venv_site_packages = _site_packages(_skill_venv_path(request.lockfile_hash))
        if not os.path.isdir(venv_site_packages):
            raise CheckFailed(f"the skill venv has no site-packages at {venv_site_packages}")
    suppression_rule = toolchain_rule(toolchain, "suppressions", "suppression")
    imports_rule = toolchain_rule(toolchain, "imports", "Imports")
    installed = {} if venv_site_packages is None else imports_rule.installed_modules(venv_site_packages)
    scanned = {file: suppression_findings(suppression_rule, file, body, lines[file]) for file, body in bodies.items()}
    with tempfile.TemporaryDirectory(prefix="cogmo-check-") as directory:
        for file, body in bodies.items():
            with open(os.path.join(directory, file), "w", encoding="utf-8", newline="") as f:
                f.write(body)
        files = _Files(directory, lines)
        findings = [
            *ruff_findings(toolchain, files),
            *format_findings(toolchain, files),
            *pyrefly_findings(toolchain, files, venv_site_packages),
            *(
                finding
                for file, body in bodies.items()
                for finding in import_findings(imports_rule, file, body, lines[file], request.dependencies, installed)
            ),
            *(finding for refused, _ in scanned.values() for finding in refused),
        ]
    return Checked(findings, scanned[SKILL_FILE][1])


def bounded(findings: Sequence[Finding]) -> list[Finding]:
    """The first `MAX_FINDINGS` findings, each message cut to `MAX_MESSAGE` code points, then one finding per file and
    check counting what it found past them, so a reply stays far below the 1 MiB the host reads of it."""
    kept = [replace(f, message=_cut(f.message)) for f in findings[:MAX_FINDINGS]]
    left_out = Counter((f.file, f.id) for f in findings[MAX_FINDINGS:])
    return [
        *kept,
        *(
            Finding(check_id, file, None, None, f"and {n} more {check_id} findings")
            for (file, check_id), n in left_out.items()
        ),
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
            "testRunner": True,
        }
    except CheckFailed as e:
        reply = {"type": "fatal", "error": str(e)}
    stdout.write(json.dumps(reply) + "\n")
    stdout.flush()


if __name__ == "__main__":
    main(sys.stdin, sys.stdout, image_toolchain)
