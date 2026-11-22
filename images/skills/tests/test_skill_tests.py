"""Register's run of a skill's tests (`cogmo_skills_runtime.skill_tests`), with this project's pytest.

The suite runs this environment's pytest and pytest-asyncio, at the toolchain's pins, from its site-packages, against
a toolchain directory holding `cogmo_ctx` as the image's does. A skill venv is a directory of distributions laid out as
an installer leaves them.
"""

import io
import json
import os
import re
import shutil
import subprocess
import sys
import sysconfig
import tempfile
import time
import xml.etree.ElementTree as ET
from collections.abc import Callable, Mapping
from pathlib import Path

import pytest

from cogmo_skills_runtime import skill_tests, supervisor
from cogmo_skills_runtime.skill_tests import Suite

from .distributions import install

type ProtocolCheck = Callable[[str, object], None]

_IMAGE = Path(__file__).parent.parent
_UNTRACKED = shutil.ignore_patterns("__pycache__", "*.py[co]")
_HASH = "c" * 64
_MINOR = f"{sys.version_info.major}.{sys.version_info.minor}"

_MANIFEST = "---\nname: echo\ntier: container\n---\n"
_SKILL = """\
async def run(inputs, ctx):
    return {"x": inputs["x"] + 1}
"""


def _toolchain(tmp_path: Path) -> Path:
    """The toolchain as the image bakes it, `cogmo_ctx` joined into `.cogmo/`; its `pyproject.toml`."""
    root = tmp_path / "toolchain"
    root.mkdir()
    shutil.copy(_IMAGE / "toolchain" / "pyproject.toml", root / "pyproject.toml")
    shutil.copytree(_IMAGE / "toolchain" / ".cogmo", root / ".cogmo", ignore=_UNTRACKED)
    shutil.copytree(_IMAGE / "src" / "cogmo_ctx", root / ".cogmo" / "cogmo_ctx", ignore=_UNTRACKED)
    return root / "pyproject.toml"


@pytest.fixture
def suite(tmp_path: Path) -> Suite:
    return Suite(os.fspath(_toolchain(tmp_path)), sysconfig.get_path("purelib"), 30)


@pytest.fixture(autouse=True)
def scratch(tmp_path: Path, monkeypatch: pytest.MonkeyPatch) -> Path:
    """Where the runner makes, and leaves, each run's fresh directory."""
    root = tmp_path / "scratch"
    root.mkdir()
    monkeypatch.setattr(tempfile, "tempdir", os.fspath(root))
    return root


@pytest.fixture
def venvs(tmp_path: Path, monkeypatch: pytest.MonkeyPatch) -> Path:
    root = tmp_path / "skill-venvs"
    root.mkdir()
    monkeypatch.setattr(supervisor, "SKILL_VENVS_ROOT", os.fspath(root))
    return root


def _files(test_body: str, **extra: str) -> dict[str, str]:
    return {"SKILL.md": _MANIFEST, "skill.py": _SKILL, "test_skill.py": test_body, **extra}


def _reply(suite: Suite, request: Mapping[str, object]) -> dict[str, object]:
    stdout = io.StringIO()
    skill_tests.main(io.StringIO(json.dumps(request)), stdout, lambda: suite)
    lines = stdout.getvalue().splitlines()
    assert len(lines) == 1, stdout.getvalue()
    return json.loads(lines[0])


def _run(suite: Suite, test_body: str, **extra: str) -> dict[str, object]:
    """The reply for a skill with no dependencies, its `test_skill.py` `test_body`."""
    return _reply(suite, {"files": _files(test_body, **extra), "lockfileHash": None})


def _findings(reply: Mapping[str, object]) -> list[tuple[int | None, str]]:
    assert reply["type"] == "test_findings", reply
    findings = reply["findings"]
    assert isinstance(findings, list)
    return [(f["line"], f["message"]) for f in findings]


def _fatal(reply: Mapping[str, object]) -> str:
    assert reply["type"] == "fatal", reply
    return str(reply["error"])


# --- the outcome table


def test_a_suite_that_passes_has_no_findings_and_counts_its_tests(suite: Suite, protocol: ProtocolCheck) -> None:
    reply = _run(
        suite,
        """\
from pathlib import Path

import pytest

from skill import run


async def test_adds():
    print("printed by the test")
    assert await run({"x": 1}, None) == {"x": 2}


def test_sees_the_skills_files():
    assert Path("SKILL.md").read_text().startswith("---")
    assert Path("requirements.lock").read_text() == "idna==3.10\\n"


@pytest.mark.skip
def test_skipped():
    pass
""",
        **{"requirements.lock": "idna==3.10\n"},
    )

    protocol("skill_tests_reply", reply)
    assert reply == {"type": "test_findings", "findings": [], "count": 3}


def test_the_request_the_host_sends_is_a_skill_tests_request(protocol: ProtocolCheck) -> None:
    protocol("skill_tests_request", {"files": _files("", **{"requirements.lock": ""}), "lockfileHash": _HASH})
    protocol("skill_tests_request", {"files": _files(""), "lockfileHash": None})


def test_each_failed_or_errored_test_is_a_finding_at_its_definition(suite: Suite, protocol: ProtocolCheck) -> None:
    reply = _run(
        suite,
        """\
import pytest

from skill import run


async def test_adds():
    assert await run({"x": 1}, None) == {"x": 2}


@pytest.mark.parametrize("x", [1, 2])
async def test_wrong(x):
    assert await run({"x": x}, None) == {"x": 0}


class TestSetup:
    def test_needs(self, missing_fixture):
        pass


def test_forks_past_the_pids_limit():
    raise BlockingIOError(11, "Resource temporarily unavailable")
""",
    )

    protocol("skill_tests_reply", reply)
    assert _findings(reply) == [
        (10, "test_wrong[1]: AssertionError: assert {'x': 2} == {'x': 0}"),
        (10, "test_wrong[2]: AssertionError: assert {'x': 3} == {'x': 0}"),
        (16, "TestSetup::test_needs: error: fixture 'missing_fixture' not found"),
        (20, "test_forks_past_the_pids_limit: BlockingIOError: [Errno 11] Resource temporarily unavailable"),
    ]
    assert reply["count"] == 5


def test_a_test_module_that_does_not_import_is_one_finding_about_the_run(suite: Suite) -> None:
    reply = _run(suite, "import not_a_declared_dependency\n\n\ndef test_a():\n    pass\n")

    assert _findings(reply) == [
        (None, "collecting test_skill.py: ModuleNotFoundError: No module named 'not_a_declared_dependency'")
    ]


def test_a_file_with_no_test_is_one_finding(suite: Suite) -> None:
    assert _findings(_run(suite, "X = 1\n")) == [(None, "test_skill.py holds no test")]


def test_a_usage_error_is_fatal(suite: Suite, protocol: ProtocolCheck) -> None:
    config = Path(suite.config)
    config.write_text(config.read_text().replace('asyncio_mode = "auto"', 'asyncio_mode = "auto"\naddopts = "--bogus"'))

    reply = _run(suite, "def test_a():\n    pass\n")

    protocol("skill_tests_reply", reply)
    error = _fatal(reply)
    assert error.startswith("pytest refused its command line or the toolchain's configuration: ")
    assert "unrecognized arguments: --bogus" in error


@pytest.mark.parametrize(
    ("test_body", "ended", "quoted"),
    [
        # Module code calling `sys.exit` is pytest's internal error.
        ("import sys\n\nsys.exit(7)\n", "pytest exited 3: ", "SystemExit: 7"),
        (
            "import os\n\n\ndef test_a():\n    os._exit(9)\n",
            "pytest exited 9, writing no report that parses: ",
            "test_a",
        ),
        (
            "import os\nimport signal\n\n\ndef test_a():\n    os.kill(os.getpid(), signal.SIGKILL)\n",
            "pytest was killed by SIGKILL, writing no report that parses: ",
            "test_a",
        ),
    ],
)
def test_any_other_end_is_a_finding_naming_the_status_and_quoting_pytest(
    suite: Suite, test_body: str, ended: str, quoted: str
) -> None:
    [(line, message)] = _findings(_run(suite, test_body))

    assert line is None
    assert message.startswith(ended)
    assert quoted in message
    assert "\n" not in message


def _cases(*cases: str) -> list[ET.Element]:
    return list(ET.fromstring(f"<testsuite>{''.join(cases)}</testsuite>").iter("testcase"))


_PASSED = '<testcase classname="test_skill" name="test_a" line="0" />'
_FAILED = (
    '<testcase classname="test_skill" name="test_a" line="0"><failure message="boom">E   boom</failure></testcase>'
)
_UNCOLLECTED = (
    '<testcase classname="" name="test_skill"><error message="collection failure">E   boom</error></testcase>'
)


@pytest.mark.parametrize(
    ("status", "cases", "ended"),
    [
        (0, _cases(), "pytest exited 0: "),
        (0, _cases(_FAILED), "pytest exited 0: "),
        (0, "writing no report that parses", "pytest exited 0, writing no report that parses: "),
        (1, _cases(_PASSED), "pytest exited 1: "),
        (1, _cases(_UNCOLLECTED), "pytest exited 1: "),
        (2, _cases(_PASSED), "pytest exited 2: "),
        (2, _cases(_FAILED), "pytest exited 2: "),
        (5, _cases(_PASSED), "pytest exited 5: "),
        (1, "writing no report that parses", "pytest exited 1, writing no report that parses: "),
    ],
)
def test_a_report_at_odds_with_the_status_is_a_finding_about_the_run(
    status: int, cases: list[ET.Element] | str, ended: str
) -> None:
    [finding] = skill_tests.judge(status, cases, "the tail\nof the output\n")

    assert (finding.line, finding.message) == (None, f"{ended}the tail of the output")


def test_a_line_that_is_not_a_decimal_number_is_no_line() -> None:
    # `"²".isdigit()` holds, and `int("²")` raises.
    failed = (
        '<testcase classname="test_skill" name="test_a" line="²"><failure message="boom">E   boom</failure></testcase>'
    )

    [finding] = skill_tests.judge(1, _cases(failed), "")

    assert (finding.line, finding.message) == (None, "test_a: boom")


def test_a_line_past_the_int_conversion_limit_is_no_line() -> None:
    long = "1" * (sys.get_int_max_str_digits() + 1)
    failed = f'<testcase classname="test_skill" name="test_a" line="{long}"><failure message="boom" /></testcase>'

    [finding] = skill_tests.judge(1, _cases(failed), "")

    assert (finding.line, finding.message) == (None, "test_a: boom")


def test_a_report_over_the_bound_is_refused_unread(suite: Suite) -> None:
    [(line, message)] = _findings(_run(suite, 'def test_a():\n    raise AssertionError("x" * 5_000_000)\n'))

    assert line is None
    assert re.fullmatch(
        r"pytest exited 1, writing a report of \d+ bytes, over the 4194304 the runner reads: .*", message
    )


def test_a_quoted_tail_drops_the_run_its_cut_ran_through() -> None:
    # The cut lands inside the URL's userinfo, past the `://` a mask recognises it by.
    output = f"setup https://owner:{'hunter2' * 60}@example.com/data failed\n"

    [finding] = skill_tests.judge(3, _cases(), output)

    assert finding.message == "pytest exited 3: … failed"


def test_the_output_read_drops_the_run_its_seek_landed_in(tmp_path: Path) -> None:
    # The seek lands inside the URL's userinfo; whitespace fills the rest, so too little is left for the quote's cut.
    secret = f"{'hunter2' * 10}@example.com/data"
    head = f"setup https://owner:{secret}"
    output = tmp_path / "output.log"
    output.write_text(f"{head}{' ' * (64 * 1024 - len(secret) + 10)}failed\n")

    [finding] = skill_tests.judge(3, _cases(), skill_tests._output_tail(os.fspath(output)))

    assert finding.message == "pytest exited 3: … failed"


def test_a_suite_past_its_cap_names_the_running_test_and_its_process_group_dies(suite: Suite, tmp_path: Path) -> None:
    pid_file = tmp_path / "grandchild.pid"
    reply = _run(
        Suite(suite.config, suite.site_packages, 2),
        f"""\
import subprocess
import sys
import time

import pytest


def test_quick():
    pass


class TestSlow:
    @pytest.mark.parametrize("n", [1])
    def test_hangs(self, n):
        child = subprocess.Popen([sys.executable, "-c", "import time; time.sleep(300)"])
        open({os.fspath(pid_file)!r}, "w").write(str(child.pid))
        time.sleep(300)
""",
    )

    assert _findings(reply) == [(13, "TestSlow::test_hangs[1]: still running when the suite reached its 2 s cap")]
    assert reply["count"] == 0
    assert _gone(int(pid_file.read_text()))


def test_what_a_passing_suite_leaves_running_in_its_group_dies(suite: Suite, tmp_path: Path) -> None:
    pid_file = tmp_path / "straggler.pid"
    reply = _run(
        suite,
        f"""\
import subprocess
import sys


def test_leaves_a_child():
    child = subprocess.Popen([sys.executable, "-c", "import time; time.sleep(300)"])
    open({os.fspath(pid_file)!r}, "w").write(str(child.pid))
""",
    )

    assert reply == {"type": "test_findings", "findings": [], "count": 1}
    assert _gone(int(pid_file.read_text()))


def test_the_runner_leaves_its_directory_to_the_session(suite: Suite, scratch: Path) -> None:
    _run(suite, "def test_a():\n    pass\n")

    [base] = scratch.iterdir()
    assert (base / "skill" / "test_skill.py").read_text() == "def test_a():\n    pass\n"


def _exited_unreaped(argv: list[str]) -> subprocess.Popen[bytes]:
    child = subprocess.Popen(argv)
    os.waitid(os.P_PID, child.pid, os.WEXITED | os.WNOWAIT)
    return child


def test_an_exit_first_seen_at_the_deadline_is_at_the_cap() -> None:
    child = _exited_unreaped([sys.executable, "-c", "pass"])
    try:
        assert not skill_tests._exited_by(child.pid, time.monotonic())
        assert skill_tests._exited_by(child.pid, time.monotonic() + 30)
    finally:
        child.wait()


class _Clock:
    """A clock in place of the `time` module the wait reads, recording each sleep."""

    def __init__(self) -> None:
        self.now = 0.0
        self.slept: list[float] = []

    def monotonic(self) -> float:
        return self.now

    def sleep(self, seconds: float) -> None:
        self.slept.append(seconds)
        self.now += seconds


def test_the_wait_sleeps_no_longer_than_the_time_left(monkeypatch: pytest.MonkeyPatch) -> None:
    clock = _Clock()
    monkeypatch.setattr(skill_tests, "time", clock)
    child = subprocess.Popen([sys.executable, "-c", "import time; time.sleep(300)"])
    try:
        assert not skill_tests._exited_by(child.pid, 0.07)
    finally:
        child.kill()
        child.wait()

    assert clock.slept == pytest.approx([0.05, 0.02])


def _gone(pid: int) -> bool:
    """Whether `pid` has exited, within a few seconds for its reaping."""
    for _ in range(50):
        try:
            state = Path(f"/proc/{pid}/stat").read_text().rpartition(")")[2].split()[0]
        except FileNotFoundError:
            return True
        if state == "Z":
            return True
        time.sleep(0.1)
    return False


def test_a_suite_past_its_cap_while_collecting_is_a_finding_about_the_run(suite: Suite) -> None:
    reply = _run(Suite(suite.config, suite.site_packages, 2), "import time\n\ntime.sleep(300)\n")

    assert _findings(reply) == [(None, "the suite reached its 2 s cap")]


def test_pytest_runs_in_its_own_process_group_first_in_the_oom_killers_line(suite: Suite) -> None:
    reply = _run(
        suite,
        """\
import os
import subprocess
import sys


def test_its_own_group_and_score():
    assert os.getpgid(0) == os.getpid()
    assert open("/proc/self/oom_score_adj").read().strip() == "1000"
    child = subprocess.run(
        [sys.executable, "-c", "print(open('/proc/self/oom_score_adj').read().strip())"],
        capture_output=True,
        text=True,
        check=True,
    )
    assert child.stdout.strip() == "1000"
""",
    )

    assert reply == {"type": "test_findings", "findings": [], "count": 1}


def test_the_suite_reads_the_toolchains_configuration_and_its_cogmo_ctx(suite: Suite) -> None:
    toolchain = os.fspath(Path(suite.config).parent)
    reply = _run(
        suite,
        f"""\
import sys

import cogmo_ctx


async def test_runs_without_a_marker():
    assert cogmo_ctx.__file__.startswith({toolchain!r})
    assert not sys.flags.no_site and sys.flags.no_user_site and sys.flags.safe_path
""",
    )

    assert reply == {"type": "test_findings", "findings": [], "count": 1}


# --- the skill venv


def _site_packages(venvs: Path, lockfile_hash: str) -> Path:
    return venvs / f"{lockfile_hash}-py{_MINOR}" / "lib" / f"python{_MINOR}" / "site-packages"


def test_the_skill_venv_comes_before_the_tools_venv(suite: Suite, venvs: Path) -> None:
    site_packages = _site_packages(venvs, _HASH)
    install(site_packages, "greeting", {"greeting.py": "HELLO = 'hi'\n"})
    test_body = f"""\
import sys

import greeting


def test_imports_a_dependency():
    assert greeting.HELLO == "hi"
    assert sys.path.index({os.fspath(site_packages)!r}) < sys.path.index({suite.site_packages!r})
"""
    reply = _reply(suite, {"files": _files(test_body), "lockfileHash": _HASH})

    assert reply == {"type": "test_findings", "findings": [], "count": 1}


def test_a_lockfile_without_its_skill_venv_is_fatal(suite: Suite, venvs: Path) -> None:
    error = _fatal(_reply(suite, {"files": _files("def test_a():\n    pass\n"), "lockfileHash": _HASH}))

    assert error == f"the skill venv has no site-packages at {_site_packages(venvs, _HASH)}"


@pytest.mark.parametrize(
    "request_text",
    [
        "not json",
        json.dumps({"files": {"skill.py": "", "test_skill.py": ""}, "lockfileHash": None}),
        json.dumps({"files": _files("", **{"../conftest.py": ""}), "lockfileHash": None}),
        json.dumps({"files": {**_files(""), "skill.py": 1}, "lockfileHash": None}),
        json.dumps({"files": _files(""), "lockfileHash": "../escape"}),
    ],
)
def test_a_request_the_runner_cannot_run_is_fatal(suite: Suite, request_text: str) -> None:
    stdout = io.StringIO()

    skill_tests.main(io.StringIO(request_text), stdout, lambda: suite)

    assert _fatal(json.loads(stdout.getvalue()))


def test_a_pytest_that_does_not_start_is_fatal(suite: Suite, monkeypatch: pytest.MonkeyPatch) -> None:
    def refuse() -> None:
        raise PermissionError("oom_score_adj is read-only")

    monkeypatch.setattr(skill_tests, "_favour_oom_kill", refuse)

    assert _fatal(_run(suite, "def test_a():\n    pass\n")).startswith("pytest did not start: ")


# --- the reply


def test_a_flood_of_findings_is_capped_and_each_message_cut(suite: Suite) -> None:
    reply = _run(
        suite,
        """\
import pytest


@pytest.mark.parametrize("n", range(105))
def test_fails(n):
    raise AssertionError("x" * 1000)
""",
    )

    findings = _findings(reply)
    assert len(findings) == 101
    assert all(len(message) == 400 and message.endswith("…") for _, message in findings[:100])
    assert findings[100] == (None, "and 5 more tests findings")
    assert reply["count"] == 105


def test_the_image_suite_is_the_tools_venvs_pytest_under_the_baked_toolchain() -> None:
    assert skill_tests.image_suite() == Suite(
        "/opt/cogmo-skills/toolchain/pyproject.toml",
        f"/opt/cogmo-skills/tools/lib/python{_MINOR}/site-packages",
        60,
    )


def test_the_module_runs_as_the_host_starts_it(scratch: Path) -> None:
    # Outside the image there is no baked toolchain, so pytest refuses its configuration and the one line is `fatal`.
    result = subprocess.run(
        [sys.executable, "-I", "-m", "cogmo_skills_runtime.skill_tests"],
        input=json.dumps({"files": _files("def test_a():\n    pass\n"), "lockfileHash": None}),
        capture_output=True,
        text=True,
        check=True,
        env={**os.environ, "TMPDIR": os.fspath(scratch)},
    )

    [line] = result.stdout.splitlines()
    assert json.loads(line)["type"] == "fatal"
