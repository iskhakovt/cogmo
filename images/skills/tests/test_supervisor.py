"""Unit tests for the supervisor's stdlib primitives.

The task-dispatch loop is covered end to end by `test_task_isolation.py`,
which runs the supervisor as a subprocess; these tests pin the building
blocks: pidfd-based wait, SIGKILL+reap, venv activation, and the task
process entry point.
"""

import json
import os
import time
from collections.abc import Generator

import pytest

from cogmo_skills_runtime import supervisor
from cogmo_skills_runtime.supervisor import (
    _activate_skill_venv,
    _kill_and_reap,
    _run_one_task_in_child,
    _skill_venv_path,
    _wait_with_timeout,
)

# `os.pidfd_open` requires Linux kernel 5.3+ AND a Python build that
# enabled HAVE_PIDFD_OPEN at configure time. The runtime image
# (`python:3.14-slim`) has it; some uv-downloaded `python-build-standalone`
# builds for Python 3.14 do not. Tests that depend on `pidfd_open` skip
# when it's missing — the integration test (sysbox-e2e job) covers the
# pidfd path against the actual runtime python.
_pidfd_required = pytest.mark.skipif(
    not hasattr(os, "pidfd_open"),
    reason="os.pidfd_open unavailable on this build of CPython",
)


def _fork_sleeper(seconds: float) -> int:
    """Fork a child that sleeps then exits cleanly."""
    pid = os.fork()
    if pid == 0:
        time.sleep(seconds)
        os._exit(0)
    return pid


@_pidfd_required
class TestWaitWithTimeout:
    def test_returns_when_child_exits_in_time(self) -> None:
        pid = _fork_sleeper(0.05)
        status = _wait_with_timeout(pid, timeout_s=2.0)
        assert os.WIFEXITED(status)
        assert os.WEXITSTATUS(status) == 0

    def test_raises_timeout_when_child_runs_long(self) -> None:
        pid = _fork_sleeper(2.0)
        try:
            with pytest.raises(TimeoutError):
                _wait_with_timeout(pid, timeout_s=0.05)
        finally:
            # Clean up the long-running child so the test process doesn't
            # leak it when the suite ends.
            _kill_and_reap(pid)

    def test_closes_pidfd_on_normal_path(self) -> None:
        # Approximate fd-leak detection: if pidfd_open leaked, we'd
        # eventually run out of fds. Open many in succession and assert
        # we don't ENFILE.
        for _ in range(64):
            pid = _fork_sleeper(0.01)
            _wait_with_timeout(pid, timeout_s=2.0)


class TestKillAndReap:
    def test_kills_running_child(self) -> None:
        pid = _fork_sleeper(60.0)  # would outlive any test budget
        start = time.monotonic()
        _kill_and_reap(pid)
        elapsed = time.monotonic() - start
        # SIGKILL is fast — should complete in well under SIGKILL_GRACE_S.
        assert elapsed < 2.0

    def test_silent_on_already_dead_child(self) -> None:
        pid = _fork_sleeper(0.01)
        # Wait for natural exit, then ask kill_and_reap to clean up the
        # zombie. Should not raise even though the process is gone.
        time.sleep(0.05)
        _kill_and_reap(pid)


class TestRunOneTaskInChild:
    def test_writes_task_result_for_simple_skill(self, capsys: pytest.CaptureFixture[str]) -> None:
        body = "async def run(inputs, ctx):\n    return {'echo': inputs.get('x', 0) + 1}\n"
        task = {
            "type": "task_invoke",
            "id": "t-echo",
            "skill": "echo",
            "inputs": {"x": 41},
            "body": body,
        }
        _run_one_task_in_child(task)
        captured = capsys.readouterr()
        result = json.loads(captured.out.strip())
        # Subset assertion — every task_result also carries `rusage` from the
        # runner. Shape covered in test_runner.py's TestRusage.
        assert result["type"] == "task_result"
        assert result["id"] == "t-echo"
        assert result["ok"] is True
        assert result["output"] == {"echo": 42}

    def test_writes_task_result_for_skill_with_syntax_error(self, capsys: pytest.CaptureFixture[str]) -> None:
        task = {
            "type": "task_invoke",
            "id": "t-bad",
            "skill": "bad",
            "inputs": {},
            "body": "def bad(:\n",  # unbalanced paren — fails at compile time
        }
        _run_one_task_in_child(task)
        captured = capsys.readouterr()
        result = json.loads(captured.out.strip())
        assert result["type"] == "task_result"
        assert result["id"] == "t-bad"
        assert result["ok"] is False
        assert "SyntaxError" in result["error"]

    def test_writes_task_result_when_skill_raises(self, capsys: pytest.CaptureFixture[str]) -> None:
        task = {
            "type": "task_invoke",
            "id": "t-raise",
            "skill": "raise",
            "inputs": {},
            "body": "async def run(inputs, ctx):\n    raise ValueError('boom')\n",
        }
        _run_one_task_in_child(task)
        captured = capsys.readouterr()
        result = json.loads(captured.out.strip())
        assert result["ok"] is False
        assert "ValueError" in result["error"]
        assert "boom" in result["error"]

    def test_rejects_skill_without_async_run(self, capsys: pytest.CaptureFixture[str]) -> None:
        task = {
            "type": "task_invoke",
            "id": "t-no-run",
            "skill": "missing",
            "inputs": {},
            "body": "def not_run(inputs, ctx):\n    return None\n",
        }
        _run_one_task_in_child(task)
        captured = capsys.readouterr()
        result = json.loads(captured.out.strip())
        assert result["ok"] is False
        assert "async def run" in result["error"]


class TestActivateSkillVenv:
    """Pin the activation contract: site-packages prepended to
    sys.path, VIRTUAL_ENV + PATH set. Tests run in the test process
    itself (not in a forked child), so we snapshot + restore env state
    around each case.
    """

    @pytest.fixture(autouse=True)
    def restore_env(self) -> Generator[None]:
        import sys

        saved_path = list(sys.path)
        saved_env = dict(os.environ)
        yield
        sys.path[:] = saved_path
        os.environ.clear()
        os.environ.update(saved_env)

    # Fixed sha256-hex used across the activation tests; matches the
    # protocol's `lockfileHash` shape so the supervisor's path
    # computation runs against a real-looking input.
    _HASH = "a" * 64

    @pytest.fixture(autouse=True)
    def _redirect_skill_venvs_root(
        self, tmp_path: object, monkeypatch: pytest.MonkeyPatch
    ) -> None:
        """Point `SKILL_VENVS_ROOT` at the per-test tmpdir so the
        supervisor's `_skill_venv_path` computes a path under our
        control. Production wiring uses `/skill-venvs/`, which tests
        can't write to."""
        monkeypatch.setattr(supervisor, "SKILL_VENVS_ROOT", os.fspath(tmp_path))  # type: ignore[arg-type]

    def _build_fake_venv(self, tmp_path: object) -> str:
        """Build a fake venv at the path `_skill_venv_path(_HASH)` resolves
        to under the redirected root. Mirrors the populate script's
        layout so `_activate_skill_venv(_HASH)` finds it."""
        import sys

        venv = _skill_venv_path(self._HASH)
        site_packages = os.path.join(
            venv, "lib", f"python{sys.version_info.major}.{sys.version_info.minor}", "site-packages"
        )
        os.makedirs(site_packages)
        os.makedirs(os.path.join(venv, "bin"))
        return venv

    def test_skill_venv_path_includes_python_abi(self) -> None:
        """Image bumps that change Python minor must route to a fresh
        venv. The path embeds `py<major>.<minor>` so the populate
        script and supervisor (same image, same `sys.version_info`)
        construct the same path."""
        import sys

        venv = _skill_venv_path(self._HASH)
        expected_suffix = f"-py{sys.version_info.major}.{sys.version_info.minor}"
        assert venv.endswith(self._HASH + expected_suffix)

    @pytest.mark.parametrize(
        "bad",
        [
            "..",
            "../etc/passwd",
            "/absolute/path",
            "a" * 63,
            "A" * 64,
            "g" * 64,
            "",
        ],
    )
    def test_skill_venv_path_rejects_non_sha256(self, bad: str) -> None:
        """`os.path.join` doesn't normalise `..`, so a malformed
        lockfile_hash on the wire could otherwise escape
        `SKILL_VENVS_ROOT`. The supervisor refuses anything that isn't
        a sha256-hex string."""
        with pytest.raises(RuntimeError, match="lockfile_hash must be sha256 hex"):
            _skill_venv_path(bad)

    def test_prepends_site_packages_to_sys_path(self, tmp_path: object) -> None:
        import sys

        venv = self._build_fake_venv(tmp_path)
        _activate_skill_venv(self._HASH)
        expected = os.path.join(
            venv, "lib", f"python{sys.version_info.major}.{sys.version_info.minor}", "site-packages"
        )
        assert sys.path[0] == expected

    def test_sets_virtual_env_and_prepends_bin_to_path(self, tmp_path: object) -> None:
        venv = self._build_fake_venv(tmp_path)
        os.environ["PATH"] = "/usr/bin:/bin"
        _activate_skill_venv(self._HASH)
        assert os.environ["VIRTUAL_ENV"] == venv
        assert os.environ["PATH"].startswith(f"{venv}/bin:")
        assert "/usr/bin:/bin" in os.environ["PATH"]

    def test_handles_empty_existing_path(self, tmp_path: object) -> None:
        venv = self._build_fake_venv(tmp_path)
        os.environ.pop("PATH", None)
        _activate_skill_venv(self._HASH)
        assert os.environ["PATH"] == os.path.join(venv, "bin")

    def test_raises_when_site_packages_is_missing(self) -> None:
        """Regression for the ABI-mismatch wedge: when an image upgrade
        changes Python minor, the old `<hash>-py3.14/` dir stays but
        the new supervisor's `_skill_venv_path(<hash>)` resolves to
        `<hash>-py3.15/` which doesn't exist. Activate should raise a
        meaningful error instead of silently working with the wrong
        layout."""
        # No `_build_fake_venv` -> the resolved path doesn't exist.
        with pytest.raises(RuntimeError, match="has no site-packages"):
            _activate_skill_venv(self._HASH)

    def test_run_one_task_in_child_activates_when_lockfile_hash_present(
        self, tmp_path: object, capsys: pytest.CaptureFixture[str]
    ) -> None:
        """Drop a stub module into the fake venv's site-packages, then
        run a skill body that imports it. Without activation, the
        import would fail; with activation, the task_result is
        ok=true.
        """
        import sys

        venv = self._build_fake_venv(tmp_path)
        site_packages = os.path.join(
            venv, "lib", f"python{sys.version_info.major}.{sys.version_info.minor}", "site-packages"
        )
        with open(os.path.join(site_packages, "skillvenv_marker.py"), "w") as f:
            f.write("ANSWER = 42\n")
        body = (
            "async def run(inputs, ctx):\n"
            "    import skillvenv_marker\n"
            "    return {'answer': skillvenv_marker.ANSWER}\n"
        )
        task = {
            "type": "task_invoke",
            "id": "t-venv",
            "skill": "venv-import",
            "inputs": {},
            "body": body,
            "lockfileHash": self._HASH,
        }
        _run_one_task_in_child(task)
        captured = capsys.readouterr()
        result = json.loads(captured.out.strip())
        assert result["ok"] is True, result
        assert result["output"] == {"answer": 42}


class TestSupervisorImportSafety:
    """Importing the supervisor module shouldn't have side effects.

    The TS host runs the supervisor via `python3 -u -m
    cogmo_skills_runtime`, which executes `__main__.py`'s
    `main()` only when invoked. Tests + lint passes import the
    package; importing must not start the dispatch loop, fork, or
    write to stdout.
    """

    def test_import_does_nothing(self, capsys: pytest.CaptureFixture[str]) -> None:
        import cogmo_skills_runtime  # noqa: F401
        from cogmo_skills_runtime import supervisor  # noqa: F401

        captured = capsys.readouterr()
        assert captured.out == ""
        assert captured.err == ""

    def test_main_is_callable_without_running(self) -> None:
        from cogmo_skills_runtime.supervisor import main

        assert callable(main)
        # We don't actually call it — that would block on stdin forever.
        # test_task_isolation.py runs the full loop in a subprocess.
