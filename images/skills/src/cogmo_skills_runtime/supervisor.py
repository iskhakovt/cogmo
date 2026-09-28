"""Long-lived task-dispatch supervisor.

Architecture (see design/skills.md "Warm pool"):

  - The TS worker (`src/skills/worker-sysbox/worker.ts`) spawns this
    module via `python3 -u -m cogmo_skills_runtime` once at create
    time. It announces `supervisor_ready` with its protocol version and
    stays alive across the worker's lifetime.
  - Three processes per task, all forked from the supervisor's clean
    `sys.modules` snapshot:

      supervisor (subreaper, non-dumpable; owns the host channel, never reads it)
        └─ relay    (one per task; reads the host channel, relays one task)
             └─ task (runs the skill; stdin/stdout are private pipes to the relay)

    The relay forks the task process *before* it reads anything from the
    host, so no task's process ever inherits host data read on another
    task's behalf. The supervisor never reads host input at all.
  - The relay forwards the task's `ctx_call`s stamped with the task id,
    delivers only `ctx_result`s carrying that id, forwards the task's one
    `task_result`, and stops. It enforces the wall clock.
  - Once the relay exits, the supervisor SIGKILLs every process still
    in its subtree — the task, anything the task forked, detached or
    re-sessioned — and reaps them. Orphans reparent to the supervisor
    (`PR_SET_CHILD_SUBREAPER`), so the subtree is complete. Only when it
    is empty does the supervisor send `task_exited`, which is what
    releases the worker host-side. A subtree it cannot empty makes the
    supervisor exit, which the host treats as a dead worker.
  - The supervisor and relay are non-dumpable (`PR_SET_DUMPABLE` 0), so
    a task running as the same uid cannot open their host fds through
    `/proc/<pid>/fd` or ptrace them. Task processes start a new session
    (so `kill(0, …)` stays inside the task) with `PR_SET_NO_NEW_PRIVS`.

Why hand-rolled (vs `multiprocessing` / `pebble`):
`multiprocessing.process.BaseProcess._bootstrap()` unconditionally
calls `util._close_stdin()` in every worker child, and neither library
kills a task's descendants or gives the relay a channel the task cannot
write to. PEP 734 subinterpreters considered too; ecosystem isn't ready
(numpy/pandas don't support `Py_mod_multiple_interpreters`, async bridge
is hand-rolled, no production adopters). Revisit at 3.16+.
"""

import asyncio
import ctypes
import errno
import gc
import json
import os
import re
import selectors
import signal
import sys
import time
import traceback
from collections.abc import Mapping
from typing import Any

from cogmo_skills_runtime.runner import _main as _run_main

# Wire protocol version announced in `supervisor_ready`. The host refuses
# a supervisor announcing any other version (`SUPERVISOR_PROTOCOL_VERSION`
# in `src/skills/protocol.ts`).
PROTOCOL_VERSION = 2

DEFAULT_WALL_CLOCK_S = 60
SIGKILL_GRACE_S = 2.0
# Supervisor backstop past the relay's own wall clock, for a relay that
# stopped responding (e.g. SIGSTOPped by the task it serves).
RELAY_GRACE_S = 2.0
# How long the supervisor keeps killing a task's subtree before giving up
# on the worker.
SWEEP_DEADLINE_S = 2.0

# Matches the runner's frame cap: a `ctx.http` body travels in both
# directions, up to the host's 5 MiB cap plus JSON escaping.
MAX_FRAME_BYTES = 16 * 1024 * 1024
_READ_CHUNK = 1 << 16

_HOST_IN = 0
_HOST_OUT = 1

# Relay exit codes, read by the supervisor.
_RELAY_DONE = 0
_RELAY_HOST_CLOSED = 3

# linux/prctl.h
_PR_SET_DUMPABLE = 4
_PR_SET_CHILD_SUBREAPER = 36
_PR_SET_NO_NEW_PRIVS = 38


def _prctl(option: int, arg: int) -> None:
    libc = ctypes.CDLL(None, use_errno=True)
    zero = ctypes.c_ulong(0)
    if libc.prctl(ctypes.c_int(option), ctypes.c_ulong(arg), zero, zero, zero) != 0:
        err = ctypes.get_errno()
        raise OSError(err, os.strerror(err))


class FrameTooLargeError(Exception):
    """A peer sent more than `MAX_FRAME_BYTES` without a newline."""


class _LineReader:
    """Splits NDJSON frames off a raw fd, holding a partial frame between reads."""

    def __init__(self, fd: int) -> None:
        self.fd = fd
        self.eof = False
        # Set when the last read on a non-blocking fd found the pipe empty.
        self.drained = False
        self._buf = bytearray()

    def read(self) -> list[bytes]:
        """One `read(2)`; returns the frames it completed. Sets `eof` when the writer closed."""
        try:
            chunk = os.read(self.fd, _READ_CHUNK)
        except BlockingIOError:
            self.drained = True
            return []
        self.drained = False
        if not chunk:
            self.eof = True
            return []
        self._buf += chunk
        frames: list[bytes] = []
        while (nl := self._buf.find(b"\n")) >= 0:
            frames.append(bytes(self._buf[:nl]))
            del self._buf[: nl + 1]
        if len(self._buf) > MAX_FRAME_BYTES:
            raise FrameTooLargeError()
        return frames


def _parse(frame: bytes) -> dict[str, Any] | None:
    try:
        msg = json.loads(frame)
    except ValueError:
        return None
    return msg if isinstance(msg, dict) else None


def _write_all(fd: int, data: bytes) -> None:
    view = memoryview(data)
    while view:
        view = view[os.write(fd, view) :]


def _send(obj: Mapping[str, object]) -> None:
    """Write one frame to the host. Only the supervisor and the relay hold the host fds."""
    _write_all(_HOST_OUT, (json.dumps(obj) + "\n").encode())


def _failure(task_id: str, error: str) -> dict[str, object]:
    return {"type": "task_result", "id": task_id, "ok": False, "error": error}


def _wait_with_timeout(pid: int, timeout_s: float) -> int:
    """Block until `pid` exits or `timeout_s` elapses.

    Returns the wait status on normal exit; raises `TimeoutError` if the
    timeout fires first (caller is expected to SIGKILL the child).
    """
    pidfd = os.pidfd_open(pid)
    try:
        # Closed explicitly: a selector and its key map form a reference
        # cycle, so dropping it leaves the epoll fd to a later GC pass.
        with selectors.DefaultSelector() as sel:
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


def _exit_detail(status: int) -> str:
    if os.WIFSIGNALED(status):
        return f"signal={os.WTERMSIG(status)}"
    return f"exit={os.WEXITSTATUS(status)}"


def _descendants(root: int) -> list[int]:
    """Every live or zombie process below `root`, from a `/proc` scan."""
    children: dict[int, list[int]] = {}
    for name in os.listdir("/proc"):
        if not name.isdigit():
            continue
        try:
            with open(f"/proc/{name}/stat", "rb") as f:
                stat = f.read()
        except OSError:
            continue  # exited mid-scan
        # `comm` may hold spaces and parens; ppid is the second field after the last ')'.
        ppid = int(stat[stat.rindex(b")") + 2 :].split()[1])
        children.setdefault(ppid, []).append(int(name))
    found: list[int] = []
    stack = [root]
    while stack:
        for child in children.get(stack.pop(), ()):
            found.append(child)
            stack.append(child)
    return found


def _reap_children() -> None:
    while True:
        try:
            pid, _ = os.waitpid(-1, os.WNOHANG)
        except ChildProcessError:
            return
        if pid == 0:
            return


def _sweep_descendants(deadline_s: float) -> bool:
    """SIGKILL and reap every process below the supervisor. True once none remain.

    Loops because a process can fork between a scan and its kill; every
    round kills everything that existed at its scan, so a forking tree
    runs out of survivors within a few rounds.
    """
    me = os.getpid()
    deadline = time.monotonic() + deadline_s
    while True:
        _reap_children()
        pids = _descendants(me)
        if not pids:
            return True
        if time.monotonic() >= deadline:
            sys.stderr.write(f"supervisor: {len(pids)} task process(es) survived the sweep: {pids}\n")
            return False
        for pid in pids:
            try:
                os.kill(pid, signal.SIGKILL)
            except (ProcessLookupError, PermissionError):
                pass
        time.sleep(0.001)


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

    Must run in the task process *before* any skill code imports. We
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
    """Runs in the task process. Returns nothing; the runner writes its
    own task_result to stdout (the private pipe to the relay).
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
                json.dumps(_failure(task_id, f"supervisor_child_aborted: {type(e).__name__}: {e}")) + "\n"
            )
            sys.stdout.flush()
        except Exception:
            pass


def _task_process(to_task_r: int, from_task_w: int) -> None:
    """Body of the task process: private stdio, then one task."""
    os.setsid()
    _prctl(_PR_SET_NO_NEW_PRIVS, 1)
    os.dup2(to_task_r, 0)
    os.dup2(from_task_w, 1)
    # Drop every other inherited fd: the relay's pipe ends and the
    # supervisor's status pipe. The host channel is gone once 0/1 are
    # replaced.
    os.closerange(3, os.sysconf("SC_OPEN_MAX"))
    reader = _LineReader(0)
    while not reader.eof:
        frames = reader.read()
        if frames:
            task = _parse(frames[0])
            if task is not None and isinstance(task.get("id"), str):
                _run_one_task_in_child(task)
            return


def _await_task_invoke(host: _LineReader) -> tuple[bytes, dict[str, Any]] | None:
    """Read host frames until a `task_invoke`. Stale frames (a late
    `ctx_result` for an earlier task) are dropped. None on EOF.
    """
    while not host.eof:
        for frame in host.read():
            msg = _parse(frame)
            if msg is None or msg.get("type") != "task_invoke":
                continue
            task_id = msg.get("id")
            if isinstance(task_id, str) and task_id:
                return frame, msg
            sys.stderr.write("supervisor: task_invoke missing 'id'\n")
    return None


class _Relay:
    """Relays one task between the host channel and the task's private pipes."""

    def __init__(self, task_id: str, task_pid: int, host: _LineReader, to_task_w: int, from_task_r: int) -> None:
        self.task_id = task_id
        self.task_pid = task_pid
        self.host = host
        self.to_task_w = to_task_w
        self.task_out = _LineReader(from_task_r)

    def run(self, wall_clock_s: float) -> int:
        os.set_blocking(self.task_out.fd, False)
        pidfd = os.pidfd_open(self.task_pid)
        sel = selectors.DefaultSelector()
        sel.register(self.task_out.fd, selectors.EVENT_READ, "task")
        sel.register(self.host.fd, selectors.EVENT_READ, "host")
        sel.register(pidfd, selectors.EVENT_READ, "exited")
        deadline = time.monotonic() + wall_clock_s
        while True:
            remaining = deadline - time.monotonic()
            if remaining <= 0:
                sys.stderr.write(f"supervisor: wall-clock {wall_clock_s}s exceeded for task {self.task_id}\n")
                _send(_failure(self.task_id, "wall_clock_exceeded"))
                return _RELAY_DONE
            ready = {key.data for key, _ in sel.select(remaining)}
            # Task output first: a task_result written just before exit
            # must win over the exit itself.
            if "task" in ready:
                if self._pump_task():
                    return _RELAY_DONE
                if self.task_out.eof:
                    sel.unregister(self.task_out.fd)
            if "host" in ready and not self._pump_host():
                return _RELAY_HOST_CLOSED
            if "exited" in ready:
                return self._on_task_exit()

    def _pump_task(self) -> bool:
        """Forward what the task wrote. True once its task_result is out."""
        try:
            frames = self.task_out.read()
        except FrameTooLargeError:
            _send(_failure(self.task_id, "task_frame_too_large"))
            return True
        for frame in frames:
            msg = _parse(frame)
            if msg is None:
                continue
            kind = msg.get("type")
            if kind == "task_result":
                msg.pop("taskId", None)
                _send({**msg, "id": self.task_id})
                return True
            if kind == "ctx_call":
                call_id, method = msg.get("id"), msg.get("method")
                if isinstance(call_id, str) and call_id and isinstance(method, str) and method:
                    _send(
                        {
                            "type": "ctx_call",
                            "taskId": self.task_id,
                            "id": call_id,
                            "method": method,
                            "args": msg.get("args"),
                        }
                    )
        return False

    def _pump_host(self) -> bool:
        """Deliver this task's ctx_results. False once the host closed the channel."""
        try:
            frames = self.host.read()
        except FrameTooLargeError:
            sys.stderr.write("supervisor: oversized frame from host\n")
            return False
        if self.host.eof:
            return False
        for frame in frames:
            msg = _parse(frame)
            if msg is None or msg.get("type") != "ctx_result" or msg.get("taskId") != self.task_id:
                continue
            try:
                _write_all(self.to_task_w, frame + b"\n")
            except BrokenPipeError:
                pass  # task already closed its stdin
        return True

    def _on_task_exit(self) -> int:
        """The task process exited: forward a result it left in the pipe, else report the death."""
        # Bounded: a descendant may still hold the write end and keep writing.
        for _ in range(2 * MAX_FRAME_BYTES // _READ_CHUNK):
            if self._pump_task():
                return _RELAY_DONE
            if self.task_out.eof or self.task_out.drained:
                break
        _, status = os.waitpid(self.task_pid, 0)
        detail = _exit_detail(status)
        sys.stderr.write(f"supervisor: task {self.task_id} exited without a result: {detail}\n")
        _send(_failure(self.task_id, f"child_died: {detail}"))
        return _RELAY_DONE


def _relay(status_w: int) -> int:
    """Body of the relay process. Returns its exit code."""
    to_task_r, to_task_w = os.pipe()
    from_task_r, from_task_w = os.pipe()
    # Fork the task process before reading anything from the host, so it
    # inherits no host data.
    task_pid = os.fork()
    if task_pid == 0:
        try:
            _task_process(to_task_r, from_task_w)
        except BaseException:
            traceback.print_exc()
        finally:
            # _exit, not sys.exit — skip atexit/finalizers that could
            # double-flush inherited buffers.
            os._exit(0)
    os.close(to_task_r)
    os.close(from_task_w)

    host = _LineReader(_HOST_IN)
    try:
        invoke = _await_task_invoke(host)
    except FrameTooLargeError:
        sys.stderr.write("supervisor: oversized frame from host\n")
        return _RELAY_HOST_CLOSED
    if invoke is None:
        return _RELAY_HOST_CLOSED
    frame, task = invoke
    task_id = str(task["id"])
    wall_clock_s = task.get("wallClockS")
    if not isinstance(wall_clock_s, int | float) or isinstance(wall_clock_s, bool) or wall_clock_s <= 0:
        wall_clock_s = DEFAULT_WALL_CLOCK_S
    _write_all(status_w, json.dumps({"id": task_id, "wallClockS": wall_clock_s}).encode())
    os.close(status_w)
    try:
        _write_all(to_task_w, frame + b"\n")
    except BrokenPipeError:
        pass  # task process died before its task arrived; the exit path reports it
    return _Relay(task_id, task_pid, host, to_task_w, from_task_r).run(wall_clock_s)


def _read_all(fd: int) -> bytes:
    chunks: list[bytes] = []
    while chunk := os.read(fd, _READ_CHUNK):
        chunks.append(chunk)
    os.close(fd)
    return b"".join(chunks)


def _serve_one_task() -> bool:
    """Fork a relay, wait for it to serve one task, then clear the task's
    processes and confirm with `task_exited`. False once the host closed
    the channel.
    """
    # The task process closes every inherited fd and reuses the numbers.
    # Garbage inherited from here that owns an fd would close the task's
    # reused fd when a GC pass in the task finalizes it, so none may cross
    # the fork.
    gc.collect()
    status_r, status_w = os.pipe()
    relay_pid = os.fork()
    if relay_pid == 0:
        code = 1
        try:
            os.close(status_r)
            code = _relay(status_w)
        except BaseException:
            traceback.print_exc()
        finally:
            os._exit(code)
    os.close(status_w)

    header = _parse(_read_all(status_r))
    if header is None:
        # The relay exited without taking a task: the host closed the channel.
        _, status = os.waitpid(relay_pid, 0)
        _sweep_descendants(SWEEP_DEADLINE_S)
        if not (os.WIFEXITED(status) and os.WEXITSTATUS(status) == _RELAY_HOST_CLOSED):
            sys.stderr.write(f"supervisor: relay exited before taking a task: {_exit_detail(status)}\n")
        return False

    task_id = str(header["id"])
    wall_clock_s = float(header["wallClockS"])
    host_closed = False
    try:
        status = _wait_with_timeout(relay_pid, wall_clock_s + RELAY_GRACE_S)
    except TimeoutError:
        sys.stderr.write(f"supervisor: relay for task {task_id} unresponsive; killing it\n")
        _kill_and_reap(relay_pid)
    except OSError as e:
        if e.errno != errno.ECHILD:
            _kill_and_reap(relay_pid)
    else:
        host_closed = os.WIFEXITED(status) and os.WEXITSTATUS(status) == _RELAY_HOST_CLOSED
        if not os.WIFEXITED(status) or os.WEXITSTATUS(status) not in (_RELAY_DONE, _RELAY_HOST_CLOSED):
            sys.stderr.write(f"supervisor: relay for task {task_id} died: {_exit_detail(status)}\n")

    if not _sweep_descendants(SWEEP_DEADLINE_S):
        # The worker can't be proven clean; exiting closes the host
        # channel, and the host discards the worker.
        raise SystemExit(1)
    if host_closed:
        return False
    _send({"type": "task_exited", "id": task_id})
    return True


def main() -> None:
    """Announce the protocol version, then serve tasks until the host
    closes stdin. Never reads the host channel itself — each task's relay
    does.
    """
    _prctl(_PR_SET_CHILD_SUBREAPER, 1)
    _prctl(_PR_SET_DUMPABLE, 0)
    _send({"type": "supervisor_ready", "protocolVersion": PROTOCOL_VERSION})
    while _serve_one_task():
        pass


if __name__ == "__main__":
    main()
