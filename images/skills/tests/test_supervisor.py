"""Unit tests for the supervisor's stdlib primitives.

The full task-dispatch loop is covered by the TS-side sysbox-e2e
integration test (which spawns the supervisor in a real container);
these tests pin the building blocks: pidfd-based wait, SIGKILL+reap,
and child entry point.
"""

from __future__ import annotations

import io
import json
import os
import time

import pytest

from cogmo_skills_runtime.supervisor import (
    _kill_and_reap,
    _run_one_task_in_child,
    _wait_with_timeout,
)


def _fork_sleeper(seconds: float) -> int:
    """Fork a child that sleeps then exits cleanly."""
    pid = os.fork()
    if pid == 0:
        time.sleep(seconds)
        os._exit(0)
    return pid


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
    def test_writes_task_result_for_simple_skill(
        self, capsys: pytest.CaptureFixture[str]
    ) -> None:
        body = (
            "async def run(inputs, ctx):\n"
            "    return {'echo': inputs.get('x', 0) + 1}\n"
        )
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
        assert result == {
            "type": "task_result",
            "id": "t-echo",
            "ok": True,
            "output": {"echo": 42},
        }

    def test_writes_task_result_for_skill_with_syntax_error(
        self, capsys: pytest.CaptureFixture[str]
    ) -> None:
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

    def test_writes_task_result_when_skill_raises(
        self, capsys: pytest.CaptureFixture[str]
    ) -> None:
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

    def test_rejects_skill_without_async_run(
        self, capsys: pytest.CaptureFixture[str]
    ) -> None:
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
        # The smoke test (TS sysbox-e2e job) covers the full loop.


# Suppress pytest warning for unused io import (kept for future expansion).
_ = io
