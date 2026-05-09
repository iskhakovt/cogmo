"""Long-lived task-dispatch supervisor.

Architecture (see design/skills.md "Warm pool"):

  - The TS worker (`src/skills/worker-sysbox/worker.ts`) spawns this
    module via `python3 -u -m cogmo_skills_runtime` once at create
    time. It stays alive across the worker's lifetime, forking a
    fresh child per `task_invoke`.
  - Per-task isolation: every task runs in a fresh OS process forked
    from the supervisor's `sys.modules` snapshot at create time.
    Module-level state, monkey-patches, threading state, and open
    fds from task 1 cannot leak into task 2.
  - Wall-clock kill: `os.pidfd_open` + `selectors.select(timeout=...)`
    gives a single-syscall bounded wait. On timeout the supervisor
    SIGKILLs the child and emits `wall_clock_exceeded` on the host's
    behalf; the supervisor itself stays alive for the next task.
  - Children inherit stdin/stdout from the supervisor (real
    `os.fork()` inherits FDs cleanly), so `runner._main`'s NDJSON
    bridge reads/writes the host's pipes directly.

Why hand-rolled (vs `multiprocessing` / `pebble`):
`multiprocessing.process.BaseProcess._bootstrap()` unconditionally
calls `util._close_stdin()` in every worker child regardless of `fork`
/ `forkserver` start method. Workers can't read host stdin, which
breaks the ctx-bridge over inherited stdio. Hand-rolling sidesteps
that — we own the fork lifecycle and inherit fds intact. PEP 734
subinterpreters considered too; ecosystem isn't ready (numpy/pandas
don't support `Py_mod_multiple_interpreters`, async bridge is
hand-rolled, no production adopters). Revisit at 3.16+.
"""

from __future__ import annotations

import asyncio
import errno
import json
import os
import selectors
import signal
import sys
import time
from typing import Any

from cogmo_skills_runtime.runner import _main as _run_main

DEFAULT_WALL_CLOCK_S = 60
SIGKILL_GRACE_S = 2.0


def _send(obj: dict[str, Any]) -> None:
    """Write a single JSON object to host stdout. Used only for results
    the supervisor synthesises (timeout, child died); normal task_results
    come from the child writing directly to its inherited stdout.
    """
    sys.stdout.write(json.dumps(obj) + "\n")
    sys.stdout.flush()


def _wait_with_timeout(pid: int, timeout_s: float) -> int:
    """Block until `pid` exits or `timeout_s` elapses.

    Returns the wait status on normal exit; raises `TimeoutError` if the
    timeout fires first (caller is expected to SIGKILL the child).
    """
    pidfd = os.pidfd_open(pid)
    try:
        sel = selectors.DefaultSelector()
        sel.register(pidfd, selectors.EVENT_READ)
        events = sel.select(timeout=timeout_s)
        if not events:
            raise TimeoutError()
        # Child is exit-ready; reap it.
        _, status = os.waitpid(pid, 0)
        return status
    finally:
        try:
            os.close(pidfd)
        except OSError:
            pass


def _kill_and_reap(pid: int) -> None:
    """SIGKILL the child and wait for it. Bounded by `SIGKILL_GRACE_S`
    in case the kernel is slow to deliver — we don't want the supervisor
    parked forever on a kill that already happened.
    """
    try:
        os.kill(pid, signal.SIGKILL)
    except ProcessLookupError:
        return  # already gone
    deadline = time.monotonic() + SIGKILL_GRACE_S
    while time.monotonic() < deadline:
        try:
            done_pid, _ = os.waitpid(pid, os.WNOHANG)
        except ChildProcessError:
            return
        if done_pid != 0:
            return
        time.sleep(0.01)
    # Last-ditch blocking reap — kernel almost certainly delivered by now.
    try:
        os.waitpid(pid, 0)
    except ChildProcessError:
        pass


def _run_one_task_in_child(task: dict[str, Any]) -> None:
    """Runs in the forked child. Returns nothing; the runner writes its
    own task_result to stdout. Child exits with code 0 on normal
    completion (including ctx-error / skill-exception paths — those
    still lead to a task_result before exit).
    """
    body = str(task.get("body", ""))
    inputs = task.get("inputs")
    task_id = str(task["id"])
    try:
        asyncio.run(_run_main(body, inputs, task_id))
    except BaseException as e:
        # The runner's own try/except covers normal Python exceptions;
        # this catches BaseException (KeyboardInterrupt, SystemExit) and
        # surfaces a synthetic task_result so the host doesn't hang.
        try:
            sys.stdout.write(
                json.dumps(
                    {
                        "type": "task_result",
                        "id": task_id,
                        "ok": False,
                        "error": f"supervisor_child_aborted: {type(e).__name__}: {e}",
                    }
                )
                + "\n"
            )
            sys.stdout.flush()
        except Exception:
            pass


def main() -> None:
    """Long-lived task-dispatch loop. Reads task_invoke lines from host
    stdin, forks a child per task, supervises wall-clock + reaping.
    EOF on stdin = clean shutdown.
    """
    while True:
        try:
            line = sys.stdin.readline()
        except KeyboardInterrupt:
            return
        if not line:
            return  # EOF — host closed stdin, clean shutdown.
        line = line.strip()
        if not line:
            continue
        try:
            task = json.loads(line)
        except json.JSONDecodeError:
            sys.stderr.write("supervisor: ignoring malformed line\n")
            continue
        if not isinstance(task, dict) or task.get("type") != "task_invoke":
            kind_repr = task.get("type") if isinstance(task, dict) else type(task).__name__
            sys.stderr.write(f"supervisor: ignoring non-task message: {kind_repr}\n")
            continue
        task_id = task.get("id")
        if not isinstance(task_id, str) or not task_id:
            sys.stderr.write("supervisor: task_invoke missing 'id'\n")
            continue
        wall_clock_s = task.get("wallClockS") or DEFAULT_WALL_CLOCK_S

        # Fork. The child inherits stdin/stdout, the parent's pre-imports,
        # and the runner's globals. Sequential per-supervisor — only one
        # child at a time, no race on stdio.
        pid = os.fork()
        if pid == 0:
            # Child — runs one task, exits.
            try:
                _run_one_task_in_child(task)
            finally:
                # _exit, not sys.exit — skip atexit/finalizers that could
                # double-flush the inherited stdout (we already flushed
                # the task_result line) or interfere with other in-flight
                # state in the parent.
                os._exit(0)

        # Parent — wait for the child with timeout.
        try:
            _wait_with_timeout(pid, wall_clock_s)
        except TimeoutError:
            sys.stderr.write(
                f"supervisor: wall-clock {wall_clock_s}s exceeded "
                f"for task {task_id}; killing child\n"
            )
            _kill_and_reap(pid)
            _send(
                {
                    "type": "task_result",
                    "id": task_id,
                    "ok": False,
                    "error": "wall_clock_exceeded",
                }
            )
        except OSError as e:
            # pidfd_open / waitpid raised — should be very rare. Reap the
            # child if it's still around and tell the host we don't know
            # what happened.
            if e.errno != errno.ECHILD:
                sys.stderr.write(f"supervisor: wait error for task {task_id}: {e}\n")
            _kill_and_reap(pid)
            _send(
                {
                    "type": "task_result",
                    "id": task_id,
                    "ok": False,
                    "error": f"supervisor_wait_error: {e}",
                }
            )


if __name__ == "__main__":
    main()
