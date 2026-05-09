import { RUNNER_PY } from "./runner.py.js";

/**
 * Embedded Python source for the Tier-2 (sysbox container) skill supervisor.
 * One supervisor runs per warm worker for its lifetime; each task is run in
 * a fresh `os.fork()` child that reuses {@link RUNNER_PY}'s one-shot logic.
 *
 * Why fork supervisor vs spawn-per-task (B.1) vs subinterpreter / pebble:
 *
 *  - Spawn-per-task pays ~300 ms python startup + asyncio/json/uuid imports
 *    on every invocation. The supervisor pre-imports those once, and forks
 *    inherit them via copy-on-write — drops the per-task budget to ~10-30 ms.
 *  - PEP 734 subinterpreters in 3.14 are early-stage; NumPy / pandas / many
 *    C extensions don't yet support per-interp GIL (PEP 684 opt-in), and
 *    bridging asyncio across the interpreter boundary is hand-rolled. Real
 *    cost would be ~700 LOC mostly in the bridge — not worth it.
 *  - `multiprocessing` (and Pebble built on it) unconditionally calls
 *    `util._close_stdin()` in every worker child, regardless of `fork` /
 *    `forkserver` start method. Workers can't read host stdin. Working
 *    around this means either (a) dup-restore hack fighting the stdlib's
 *    design intent, or (b) a separate pipe pair the supervisor multiplexes
 *    — re-introducing the bridge complexity subinterpreters had.
 *
 * Hand-rolling the supervisor sidesteps all three. Stdlib-only, ~150 LOC,
 * sequential fork-and-wait per task. The child inherits stdin/stdout
 * directly (real `os.fork()` inherits FDs cleanly), so {@link RUNNER_PY}'s
 * existing NDJSON-on-stdio bridge runs unchanged in the child.
 *
 * Wall-clock kill uses `os.pidfd_open` + `selectors.select(timeout=...)`
 * (Linux 5.3+). On timeout the supervisor SIGKILLs the child, reaps it,
 * and emits `wall_clock_exceeded` on the host's behalf. The child's own
 * `_send` always lands a `task_result` for normal completion paths
 * (success, ctx error, skill exception) — we only synthesise a result
 * when we kill it ourselves.
 *
 * Protocol — line-buffered NDJSON over stdin/stdout:
 *   - host → supervisor: `task_invoke` lines (one per task, sequential).
 *     Field shape per `TaskInvokeSchema` in `protocol.ts`; supervisor
 *     forwards the dict to the child via the in-process call (no extra
 *     framing). EOF on stdin = clean shutdown.
 *   - host ↔ child: `ctx_call` / `ctx_result` and final `task_result` —
 *     the supervisor is parked in `waitpid()` while the child runs, so
 *     stdin/stdout sit idle from the supervisor's perspective and the
 *     child has exclusive access. After the child exits, supervisor
 *     resumes reading stdin for the next `task_invoke`.
 *
 * The child function imports the embedded {@link RUNNER_PY} source and
 * dispatches to its `_main(body, inputs, task_id)` entry point — see
 * runner.py.ts for the per-task lifecycle.
 */
export const SUPERVISOR_PY: string = `
import errno
import json
import os
import selectors
import signal
import sys
import time

# RUNNER_PY is interpolated below — defines _main(body, inputs, task_id),
# Ctx, _Bridge, etc. The forked child calls _main directly; the parent
# never references it.
${RUNNER_PY}

DEFAULT_WALL_CLOCK_S = 60
SIGKILL_GRACE_S = 2.0


def _send(obj):
    """Write a single JSON object to host stdout. Used only for results
    the supervisor synthesises (timeout, child died); normal task_results
    come from the child writing directly to its inherited stdout."""
    sys.stdout.write(json.dumps(obj) + "\\n")
    sys.stdout.flush()


def _wait_with_timeout(pid, timeout_s):
    """Block until \`pid\` exits or \`timeout_s\` elapses.

    Returns the wait status on normal exit; raises \`TimeoutError\` if the
    timeout fires first (caller is expected to SIGKILL the child).

    Implementation: \`os.pidfd_open(pid)\` returns a fd that becomes
    readable when the process is reaped-able, exactly the signal we
    want. \`selectors.select(timeout=...)\` gives us a single syscall
    that does the bounded wait without polling.
    """
    pidfd = os.pidfd_open(pid)
    try:
        sel = selectors.DefaultSelector()
        sel.register(pidfd, selectors.EVENT_READ)
        events = sel.select(timeout=timeout_s)
        if not events:
            raise TimeoutError()
        # Child is exit-ready; reap it. waitpid is non-blocking now.
        _, status = os.waitpid(pid, 0)
        return status
    finally:
        try:
            os.close(pidfd)
        except OSError:
            pass


def _kill_and_reap(pid):
    """SIGKILL the child and wait for it. Bounded by SIGKILL_GRACE_S in
    case the kernel is slow to deliver (we don't want the supervisor
    parked forever on a kill that already happened).
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


def _run_one_task_in_child(task):
    """Runs in the forked child. Returns nothing; the runner writes its
    own task_result to stdout. Child exits with code 0 on normal
    completion (including ctx-error / skill-exception paths — those still
    lead to a task_result before exit) and non-zero on hard crash.
    """
    body = task.get("body", "")
    inputs = task.get("inputs")
    task_id = task["id"]
    try:
        # _main lives in RUNNER_PY's globals; both modules share the
        # supervisor's interpreter (the child inherits the parent's
        # \`globals()\` via fork, so _main is callable directly).
        import asyncio
        asyncio.run(_main(body, inputs, task_id))
    except BaseException as e:  # noqa: BLE001 — last-resort
        # The runner's own try/except covers normal Python exceptions;
        # this catches BaseException (KeyboardInterrupt, SystemExit) and
        # surfaces a synthetic task_result so the host doesn't hang.
        try:
            sys.stdout.write(
                json.dumps({
                    "type": "task_result",
                    "id": task_id,
                    "ok": False,
                    "error": f"supervisor_child_aborted: {type(e).__name__}: {e}",
                }) + "\\n"
            )
            sys.stdout.flush()
        except Exception:
            pass


def main():
    """Long-lived task-dispatch loop. Reads task_invoke lines from host
    stdin, forks a child per task, supervises wall-clock + reaping.
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
            sys.stderr.write("supervisor: ignoring malformed line\\n")
            continue
        if not isinstance(task, dict) or task.get("type") != "task_invoke":
            sys.stderr.write(
                f"supervisor: ignoring non-task message: {task.get('type') if isinstance(task, dict) else type(task).__name__}\\n"
            )
            continue
        task_id = task.get("id")
        if not isinstance(task_id, str) or not task_id:
            sys.stderr.write("supervisor: task_invoke missing 'id'\\n")
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
                f"supervisor: wall-clock {wall_clock_s}s exceeded for task {task_id}; killing child\\n"
            )
            _kill_and_reap(pid)
            _send({
                "type": "task_result",
                "id": task_id,
                "ok": False,
                "error": "wall_clock_exceeded",
            })
        except OSError as e:
            # pidfd_open / waitpid raised — should be very rare. Reap the
            # child if it's still around and tell the host we don't know
            # what happened.
            if e.errno != errno.ECHILD:
                sys.stderr.write(f"supervisor: wait error for task {task_id}: {e}\\n")
            _kill_and_reap(pid)
            _send({
                "type": "task_result",
                "id": task_id,
                "ok": False,
                "error": f"supervisor_wait_error: {e}",
            })


if __name__ == "__main__":
    main()
`;
