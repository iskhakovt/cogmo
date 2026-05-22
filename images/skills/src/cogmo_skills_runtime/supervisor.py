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

import asyncio
import errno
import json
import os
import re
import selectors
import signal
import sys
import time
from collections.abc import Callable, Mapping

from cogmo_skills_runtime.runner import _main as _run_main

DEFAULT_WALL_CLOCK_S = 60
SIGKILL_GRACE_S = 2.0


def _send(obj: Mapping[str, object]) -> None:
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


# In-container root for the deps-cache volume mount. Mirrors
# `DEPS_CACHE_VOLUME_TARGET` on the TS side (`src/sandbox/index.ts`);
# the populator and supervisor must agree on this path. Module-level
# so tests can `monkeypatch.setattr(supervisor, "SKILL_VENVS_ROOT", ...)`
# to redirect venv resolution into a fixture dir.
SKILL_VENVS_ROOT = "/skill-venvs"

# Defense-in-depth: refuse non-sha256-hex values so a malformed
# lockfile_hash on the wire (e.g. `..` or an absolute path) can't
# escape `SKILL_VENVS_ROOT` via `os.path.join`. The TS-side protocol
# schema already validates the shape host-side; this is the supervisor's
# independent guard.
_LOCKFILE_HASH_RE = re.compile(r"^[0-9a-f]{64}$")


def _skill_venv_path(lockfile_hash: str) -> str:
    """Compute the venv path for a given lockfile hash on this image.

    The path includes the runtime's Python ABI so an image bump that
    changes Python minor (or major) routes to a fresh venv. The
    populate script computes the same suffix from its own
    `sys.version_info`; same image -> same Python -> same path.

    Raises RuntimeError if `lockfile_hash` isn't a sha256-hex string;
    `os.path.join` doesn't normalise `..` and would otherwise compose
    a path outside `SKILL_VENVS_ROOT` for hostile input.
    """
    if not _LOCKFILE_HASH_RE.match(lockfile_hash):
        raise RuntimeError(
            f"skill_venv: lockfile_hash must be sha256 hex (got {lockfile_hash!r})"
        )
    py_abi = f"py{sys.version_info.major}.{sys.version_info.minor}"
    return os.path.join(SKILL_VENVS_ROOT, f"{lockfile_hash}-{py_abi}")


def _activate_skill_venv(lockfile_hash: str) -> None:
    """Activate the skill venv for `lockfile_hash` in the current process.

    Must run in the forked child *before* any skill code imports. We
    prepend the venv's `site-packages` to `sys.path`, set
    `VIRTUAL_ENV`, and prepend `<venv>/bin` to PATH. The supervisor's
    own runtime venv (where `cogmo_skills_runtime` lives) stays on
    `sys.path` after the prepended entry — `import cogmo_skills_runtime`
    keeps resolving for the runner, while `import httpx` (or any other
    skill-declared dep) now resolves against the skill venv.

    Raises `RuntimeError` if the venv layout doesn't look right; the
    runner's try/except catches it and surfaces a task_result so the
    host doesn't hang.
    """
    venv_path = _skill_venv_path(lockfile_hash)
    site_packages = os.path.join(
        venv_path,
        "lib",
        f"python{sys.version_info.major}.{sys.version_info.minor}",
        "site-packages",
    )
    if not os.path.isdir(site_packages):
        raise RuntimeError(f"skill_venv has no site-packages at {site_packages}")
    sys.path.insert(0, site_packages)
    os.environ["VIRTUAL_ENV"] = venv_path
    bin_dir = os.path.join(venv_path, "bin")
    existing_path = os.environ.get("PATH", "")
    os.environ["PATH"] = f"{bin_dir}:{existing_path}" if existing_path else bin_dir


def _run_one_task_in_child(task: Mapping[str, object]) -> None:
    """Runs in the forked child. Returns nothing; the runner writes its
    own task_result to stdout. Child exits with code 0 on normal
    completion (including ctx-error / skill-exception paths — those
    still lead to a task_result before exit).
    """
    body = str(task.get("body", ""))
    inputs = task.get("inputs")
    task_id = str(task["id"])
    lockfile_hash = task.get("lockfileHash")
    try:
        if isinstance(lockfile_hash, str) and lockfile_hash:
            _activate_skill_venv(lockfile_hash)
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

    Reads via `sys.stdin.buffer` (the underlying `BufferedReader`, not
    the `TextIOWrapper`). The child uses `asyncio.connect_read_pipe`
    against `sys.stdin.buffer` too, and connect_read_pipe operates on
    the file descriptor directly — bytes parked in the parent's
    `TextIOWrapper` decode buffer would be invisible to the child's
    asyncio reader. By keeping both sides on the same `BufferedReader`
    we avoid that whole class of buffering surprise.
    """
    stdin = sys.stdin.buffer
    while True:
        try:
            line_bytes = stdin.readline()
        except KeyboardInterrupt:
            return
        if not line_bytes:
            return  # EOF — host closed stdin, clean shutdown.
        line = line_bytes.decode("utf-8", errors="replace").strip()
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
        _dispatch_one_task(task, task_id, _send)


def _dispatch_one_task(
    task: Mapping[str, object],
    task_id: str,
    send: Callable[[Mapping[str, object]], None],
) -> None:
    """Fork + run one task, supervise wall-clock + reaping, synthesize a
    `task_result` for the abnormal exit / timeout / waitpid-error paths.
    Extracted from `main()` so tests can drive a single dispatch with a
    captured `send` callback.
    """
    wall_clock_s = task.get("wallClockS") or DEFAULT_WALL_CLOCK_S
    if not isinstance(wall_clock_s, int | float):
        wall_clock_s = DEFAULT_WALL_CLOCK_S

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
        status = _wait_with_timeout(pid, wall_clock_s)
    except TimeoutError:
        sys.stderr.write(f"supervisor: wall-clock {wall_clock_s}s exceeded for task {task_id}; killing child\n")
        _kill_and_reap(pid)
        send(
            {
                "type": "task_result",
                "id": task_id,
                "ok": False,
                "error": "wall_clock_exceeded",
            }
        )
    except OSError as e:
        # pidfd_open / waitpid raised — should be very rare. ECHILD
        # means the child was already reaped by something else (we're
        # the only reaper, so this is "really shouldn't happen"); skip
        # the redundant kill on that path. For any other OSError we
        # SIGKILL as a precaution in case the process is still alive.
        if e.errno != errno.ECHILD:
            sys.stderr.write(f"supervisor: wait error for task {task_id}: {e}\n")
            _kill_and_reap(pid)
        send(
            {
                "type": "task_result",
                "id": task_id,
                "ok": False,
                "error": f"supervisor_wait_error: {e}",
            }
        )
    else:
        # Child exited on its own. Exit code 0 = task ran the runner's
        # full lifecycle and emitted its own task_result on stdout.
        # Non-zero = child died abnormally (SIGSEGV from a buggy C
        # extension, OOM-killer, SIGKILL from outside, ...) — task_result
        # was *not* written, so synthesize one here. Without this branch
        # the host would only learn via the wallClockS + 5 s watchdog,
        # which can be 65+ s for a default-budget skill.
        if not (os.WIFEXITED(status) and os.WEXITSTATUS(status) == 0):
            if os.WIFSIGNALED(status):
                detail = f"signal={os.WTERMSIG(status)}"
            else:
                detail = f"exit={os.WEXITSTATUS(status)}"
            sys.stderr.write(f"supervisor: child died abnormally for task {task_id}: {detail}\n")
            send(
                {
                    "type": "task_result",
                    "id": task_id,
                    "ok": False,
                    "error": f"child_died: {detail}",
                }
            )


if __name__ == "__main__":
    main()
