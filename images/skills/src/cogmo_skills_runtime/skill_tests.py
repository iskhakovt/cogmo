"""Register's run of a skill's tests: `python3 -I -m cogmo_skills_runtime.skill_tests`.

Reads one `skill_tests_request` on stdin: the skill's files at the tip and the hash of the lockfile whose venv holds
its dependencies. Writes the files to a fresh temporary directory, runs the tools venv's pytest over `test_skill.py`
there as a child in its own process group, killed at the suite's cap, and writes one `skill_tests_reply` line to
stdout: `test_findings`, a finding per failed or errored test, or one for a run that ended otherwise, with the count
of tests pytest's JUnit report holds; or `fatal` when the suite could not run. The host runs it in a session with no
network interface (design/skills.md → Register-time tests).
"""

import ast
import contextlib
import json
import os
import re
import signal
import subprocess
import sys
import tempfile
import time
import xml.etree.ElementTree as ET
from collections.abc import Callable, Mapping, Sequence
from dataclasses import dataclass
from typing import TextIO

from cogmo_skills_runtime.check import TEST_FILE, TOOLCHAIN_DIR, TOOLS_VENV, Finding, _site_packages, bounded
from cogmo_skills_runtime.supervisor import _skill_venv_path

# The suite's cap, past which the runner kills pytest's process group.
SUITE_TIMEOUT_S = 60

# The files a request carries: those `.cogmo/verify`'s run sees in `skills/<name>/`, the lockfile only with one.
_REQUIRED_FILES = frozenset({"SKILL.md", "skill.py", TEST_FILE})
_FILES = _REQUIRED_FILES | {"requirements.lock"}

# pytest's exit statuses: a pass, failed tests, an interrupted run (a collection error), a usage error, no tests.
_PASSED, _FAILED, _INTERRUPTED, _USAGE_ERROR, _NO_TESTS = 0, 1, 2, 4, 5

# How much of pytest's output the runner reads back, and how much of it a finding about the run quotes.
_OUTPUT_READ = 64 * 1024
_OUTPUT_TAIL = 300

# The largest JUnit report the runner parses. Well past a real suite's (a thousand failures of 4 KiB each), and few
# enough elements that a report code under test pads with tiny ones parses in far less than a session's 512 MiB.
_REPORT_MAX_BYTES = 4 * 1024 * 1024

# How often the runner looks for pytest's exit.
_POLL_S = 0.05

# A traceback's exception line in a JUnit failure or error.
_RAISED = re.compile(r"^E\s+(\S.*)$")

# What a seek into pytest's output drops: the run of text it lands in, through the whitespace ending it.
_PARTIAL_RUN = re.compile(r"\S*\s")

# The most digits a testcase's line takes: far past a bounded file's, and far short of CPython's int-conversion limit.
_LINE_DIGITS = 9


@dataclass(frozen=True)
class Suite:
    """What the suite runs with."""

    # The toolchain's `pyproject.toml`: `asyncio_mode`, and `pythonpath`, putting its `.cogmo/` and `cogmo_ctx` first.
    config: str
    # The tools venv's site-packages, which hold pytest and pytest-asyncio.
    site_packages: str
    timeout_s: float


class SuiteFailed(Exception):
    """The suite could not run; the reply is `fatal`."""


def image_suite() -> Suite:
    """The suite as the skills image runs it: the tools venv's pytest under the baked toolchain's configuration."""
    return Suite(f"{TOOLCHAIN_DIR}/pyproject.toml", _site_packages(TOOLS_VENV), SUITE_TIMEOUT_S)


@dataclass(frozen=True)
class Request:
    """A `skill_tests_request`."""

    files: Mapping[str, str]
    lockfile_hash: str | None


def parse_request(text: str) -> Request:
    try:
        request = json.loads(text)
    except ValueError as e:
        raise SuiteFailed(f"the request is not JSON: {e}") from e
    match request:
        case {"files": dict(files), "lockfileHash": str() | None as lockfile_hash} if (
            _REQUIRED_FILES <= files.keys() <= _FILES and all(isinstance(content, str) for content in files.values())
        ):
            return Request(files, lockfile_hash)
        case _:
            raise SuiteFailed("the request is not a skill_tests_request")


def _skill_site_packages(lockfile_hash: str | None) -> list[str]:
    """The skill venv's site-packages, resolved as `_activate_skill_venv` resolves it; none without a lockfile."""
    if lockfile_hash is None:
        return []
    try:
        site_packages = _site_packages(_skill_venv_path(lockfile_hash))
    except RuntimeError as e:
        raise SuiteFailed(str(e)) from e
    if not os.path.isdir(site_packages):
        raise SuiteFailed(f"the skill venv has no site-packages at {site_packages}")
    return [site_packages]


def _favour_oom_kill() -> None:
    """Runs in the child before pytest starts: the OOM killer takes it, and the children it inherits this, first."""
    with open("/proc/self/oom_score_adj", "w") as f:
        f.write("1000")


def _pytest(suite: Suite, directory: str, report: str, output: str, python_path: Sequence[str]) -> int | None:
    """pytest's exit status over `test_skill.py` in `directory`, or None when it ran past the cap.

    The child runs under this interpreter's `-P -s`, `-I` without `-E`, with an environment of its own: the skill
    venv's site-packages ahead of the tools venv's on `PYTHONPATH`, as `.cogmo/verify`'s `uv run --with-requirements`
    orders them. Its output goes to `output`, never to the reply's stdout.
    """
    argv = [
        sys.executable,
        "-P",
        "-s",
        "-m",
        "pytest",
        "-c",
        suite.config,
        "--rootdir",
        directory,
        "-p",
        "no:cacheprovider",
        "-v",
        "--junit-xml",
        report,
        "-o",
        "junit_family=xunit1",
        TEST_FILE,
    ]
    env = {
        **{name: os.environ[name] for name in ("PATH", "HOME") if name in os.environ},
        "PYTHONPATH": os.pathsep.join(python_path),
        "PYTHONDONTWRITEBYTECODE": "1",
    }
    with open(output, "wb") as log:
        try:
            child = subprocess.Popen(
                argv,
                cwd=directory,
                env=env,
                stdin=subprocess.DEVNULL,
                stdout=log,
                stderr=subprocess.STDOUT,
                process_group=0,
                preexec_fn=_favour_oom_kill,
            )
        except (OSError, subprocess.SubprocessError) as e:
            raise SuiteFailed(f"pytest did not start: {e}") from e
        exited = _exited_by(child.pid, time.monotonic() + suite.timeout_s)
        # The suite at the cap, and whatever it left running otherwise. pytest is not reaped yet, so its group's id
        # cannot have passed to another process.
        with contextlib.suppress(ProcessLookupError, PermissionError):
            os.killpg(child.pid, signal.SIGKILL)
        status = child.wait()
        return status if exited else None


def _exited_by(pid: int, deadline: float) -> bool:
    """Whether child `pid` exited by `deadline`, leaving it unreaped. An exit first seen at `deadline` is at the cap."""
    while (now := time.monotonic()) < deadline:
        if os.waitid(os.P_PID, pid, os.WEXITED | os.WNOWAIT | os.WNOHANG) is not None:
            return True
        time.sleep(min(_POLL_S, deadline - now))
    return False


def _report(path: str) -> list[ET.Element] | str:
    """The testcases of pytest's JUnit report, or why the runner reads none: none that parses, or one too large."""
    try:
        size = os.path.getsize(path)
        if size > _REPORT_MAX_BYTES:
            return f"writing a report of {size} bytes, over the {_REPORT_MAX_BYTES} the runner reads"
        return list(ET.parse(path).getroot().iter("testcase"))
    except OSError, ET.ParseError:
        return "writing no report that parses"


def _output_tail(path: str) -> str:
    """The last `_OUTPUT_READ` bytes of pytest's output. A seek that cut drops the run of text it landed in, which
    could be a secret missing the start a mask recognises it by."""
    size = os.path.getsize(path)
    with open(path, "rb") as f:
        f.seek(max(size - _OUTPUT_READ, 0))
        text = f.read().decode("utf-8", errors="replace")
    if size <= _OUTPUT_READ:
        return text
    partial = _PARTIAL_RUN.match(text)
    return f"… {text[partial.end() :]}" if partial else "…"


def _quoted(output: str) -> str:
    """The tail of pytest's output on one line. A cut drops the run of text it ran through, which could be a secret
    missing the start a mask recognises it by."""
    text = " ".join(output.split())
    if len(text) <= _OUTPUT_TAIL:
        return text
    rest = text[-_OUTPUT_TAIL:].partition(" ")[2]
    return f"… {rest}" if rest else "…"


def _case_finding(case: ET.Element) -> Finding | None:
    """A failed or errored testcase's finding, at its test's definition; None for a test that passed or skipped."""
    outcome = next((child for child in case if child.tag in ("failure", "error")), None)
    if outcome is None:
        return None
    raised = next((m.group(1) for line in (outcome.text or "").splitlines() if (m := _RAISED.match(line))), None)
    reason = raised or (outcome.get("message") or "").partition("\n")[0] or outcome.tag
    classname = case.get("classname", "")
    if not classname:
        return Finding("tests", TEST_FILE, None, None, f"collecting {TEST_FILE}: {reason}")
    line = case.get("line", "")
    test = "::".join([*classname.split(".")[1:], case.get("name", "")])
    kind = "error: " if outcome.tag == "error" else ""
    number = int(line) + 1 if line.isdecimal() and len(line) <= _LINE_DIGITS else None
    return Finding("tests", TEST_FILE, number, None, f"{test}: {kind}{reason}")


def _definition(body: str, test: str) -> int | None:
    """The 1-based line pytest gives `test`'s definition in `body`, its first decorator's; None where it finds none."""
    names = test.partition("[")[0].split("::")
    try:
        scope: list[ast.stmt] = ast.parse(body).body
    except SyntaxError, ValueError, RecursionError, MemoryError:
        return None
    line = None
    for name in names:
        defined = [
            node
            for node in scope
            if isinstance(node, ast.ClassDef | ast.FunctionDef | ast.AsyncFunctionDef) and node.name == name
        ]
        if not defined:
            return None
        node = defined[-1]
        line, scope = min([node.lineno, *(d.lineno for d in node.decorator_list)]), node.body
    return line


def _at_cap(output: str, test_body: str, timeout_s: float) -> Finding:
    """The finding for a suite past its cap, naming the test pytest's verbose progress shows running."""
    # A running test's progress line is its node id and a space; a finished one's ends with its percentage.
    running = output.rpartition("\n")[2]
    cap = f"the suite reached its {timeout_s:g} s cap"
    if not (running.startswith(f"{TEST_FILE}::") and running.endswith(" ")):
        return Finding("tests", TEST_FILE, None, None, cap)
    test = running.removeprefix(f"{TEST_FILE}::").rstrip()
    return Finding("tests", TEST_FILE, _definition(test_body, test), None, f"{test}: still running when {cap}")


def _ended(status: int) -> str:
    if status >= 0:
        return f"exited {status}"
    try:
        return f"was killed by {signal.Signals(-status).name}"
    except ValueError:
        return f"was killed by signal {-status}"


def judge(status: int, report: Sequence[ET.Element] | str, output: str) -> list[Finding]:
    """The findings of a suite that ended with `status`, its report's testcases or why it has none: none for a pass.
    A usage error is the runner's, so fatal."""
    if status == _USAGE_ERROR:
        raise SuiteFailed(f"pytest refused its command line or the toolchain's configuration: {_quoted(output)}")
    if not isinstance(report, str):
        # The module's own testcase reports its collection; every other one is a test's.
        tests = [f for case in report if case.get("classname") and (f := _case_finding(case))]
        collection = [f for case in report if not case.get("classname") and (f := _case_finding(case))]
        if status == _PASSED and report and not tests and not collection:
            return []
        if status == _FAILED and tests:
            return tests
        if status == _INTERRUPTED and collection:
            return collection
        if status == _NO_TESTS and not report:
            return [Finding("tests", TEST_FILE, None, None, f"{TEST_FILE} holds no test")]
    unread = f", {report}" if isinstance(report, str) else ""
    return [Finding("tests", TEST_FILE, None, None, f"pytest {_ended(status)}{unread}: {_quoted(output)}")]


def run_suite(request: Request, suite: Suite) -> tuple[list[Finding], int]:
    """The suite's findings over the request's files, and the count of tests its report holds.

    The fresh directory is left behind: what code under test leaves in it could make removing it fail or outlast the
    exec, and the session holding it is deleted after its one run.
    """
    python_path = [*_skill_site_packages(request.lockfile_hash), suite.site_packages]
    base = tempfile.mkdtemp(prefix="cogmo-tests-")
    directory = os.path.join(base, "skill")
    os.mkdir(directory)
    for name, text in request.files.items():
        with open(os.path.join(directory, name), "w", encoding="utf-8", newline="") as f:
            f.write(text)
    report_path, output = os.path.join(base, "report.xml"), os.path.join(base, "output.log")
    status = _pytest(suite, directory, report_path, output, python_path)
    if status is None:
        return [_at_cap(_output_tail(output), request.files[TEST_FILE], suite.timeout_s)], 0
    report = _report(report_path)
    return judge(status, report, _output_tail(output)), 0 if isinstance(report, str) else len(report)


def main(stdin: TextIO, stdout: TextIO, load_suite: Callable[[], Suite]) -> None:
    """Run the suite the request read from `stdin` names and write its one reply line to `stdout`."""
    try:
        findings, count = run_suite(parse_request(stdin.read()), load_suite())
        reply: dict[str, object] = {
            "type": "test_findings",
            "findings": [{"line": f.line, "message": f.message} for f in bounded(findings)],
            "count": count,
        }
    except SuiteFailed as e:
        reply = {"type": "fatal", "error": str(e)}
    stdout.write(json.dumps(reply) + "\n")
    stdout.flush()


if __name__ == "__main__":
    main(sys.stdin, sys.stdout, image_suite)
