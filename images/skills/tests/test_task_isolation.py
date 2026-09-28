"""Black-box tests of the supervisor protocol and task isolation.

Each test runs the real `python -m cogmo_skills_runtime` as a subprocess
and speaks the host protocol over its stdin/stdout, the way the TS
worker does. `TestTaskIsolation` pins what one task must not be able to
do to the next task on the same supervisor: get a frame past the relay
after its result, leave a process running — a detached, re-sessioned
grandchild included — that reads the next task's input or forges its
result, or open the supervisor's host channel through `/proc`.
`TestSupervisorProtocol` pins the frames, failure reporting and
teardown around that.
"""

import json
import os
import queue
import subprocess
import sys
import threading
import time
from collections.abc import Generator, Mapping
from pathlib import Path
from typing import Any

import pytest

import cogmo_skills_runtime

pytestmark = pytest.mark.skipif(
    not hasattr(os, "pidfd_open"),
    reason="os.pidfd_open unavailable on this build of CPython",
)

_SRC_DIR = str(Path(cogmo_skills_runtime.__file__).resolve().parent.parent)


class _Supervisor:
    """A supervisor subprocess plus a reader thread queueing its stdout frames.

    `patch` is Python run against the imported `supervisor` module before
    `main()`, to stub one of its internals.
    """

    def __init__(self, patch: str | None = None) -> None:
        env = dict(os.environ)
        env["PYTHONPATH"] = _SRC_DIR
        argv = ["-m", "cogmo_skills_runtime"]
        if patch is not None:
            argv = ["-c", f"from cogmo_skills_runtime import supervisor\n{patch}\nsupervisor.main()\n"]
        self.proc = subprocess.Popen(
            [sys.executable, "-u", *argv],
            stdin=subprocess.PIPE,
            stdout=subprocess.PIPE,
            env=env,
        )
        self._frames: queue.Queue[dict[str, Any] | None] = queue.Queue()
        self._reader = threading.Thread(target=self._read, daemon=True)
        self._reader.start()

    def _read(self) -> None:
        assert self.proc.stdout is not None
        for raw in self.proc.stdout:
            try:
                frame = json.loads(raw)
            except json.JSONDecodeError:
                continue
            if isinstance(frame, dict):
                self._frames.put(frame)
        self._frames.put(None)

    def send(self, frame: Mapping[str, object]) -> None:
        assert self.proc.stdin is not None
        self.proc.stdin.write((json.dumps(frame) + "\n").encode())
        self.proc.stdin.flush()

    def next_frame(self, timeout: float) -> dict[str, Any] | None:
        """The next frame, or None on timeout or supervisor EOF."""
        try:
            return self._frames.get(timeout=timeout)
        except queue.Empty:
            return None

    def run_task(self, task_id: str, body: str, inputs: object, wall_clock_s: float = 5) -> dict[str, Any]:
        """Send a task and return its `task_result`, answering no ctx calls."""
        self.send_task(task_id, body, inputs, wall_clock_s)
        while True:
            frame = self.next_frame(wall_clock_s + 5)
            assert frame is not None, f"no task_result for {task_id}"
            if frame.get("type") == "task_result":
                return frame

    def await_exit(self, task_id: str, timeout: float = 5) -> dict[str, Any] | None:
        """Wait for the supervisor to confirm the task's processes are gone."""
        while (frame := self.next_frame(timeout)) is not None:
            if frame.get("type") == "task_exited" and frame.get("id") == task_id:
                return frame
        return None

    def send_task(self, task_id: str, body: str, inputs: object, wall_clock_s: float = 5) -> None:
        self.send(
            {
                "type": "task_invoke",
                "id": task_id,
                "skill": task_id,
                "inputs": inputs,
                "body": body,
                "wallClockS": wall_clock_s,
            }
        )

    def frames_until_exit(self, timeout: float = 5) -> list[dict[str, Any]]:
        """Every frame up to and including the next `task_exited`, or up to a
        `timeout`-long silence or EOF."""
        frames: list[dict[str, Any]] = []
        while (frame := self.next_frame(timeout)) is not None:
            frames.append(frame)
            if frame.get("type") == "task_exited":
                break
        return frames

    def close(self) -> None:
        if self.proc.stdin is not None:
            self.proc.stdin.close()
        try:
            self.proc.wait(timeout=5)
        except subprocess.TimeoutExpired:
            self.proc.kill()
            self.proc.wait()


@pytest.fixture
def sup() -> Generator[_Supervisor]:
    s = _Supervisor()
    yield s
    s.close()


def _alive(pid: int) -> bool:
    """True while `pid` exists and is not a zombie."""
    try:
        with open(f"/proc/{pid}/stat") as f:
            stat = f.read()
    except FileNotFoundError:
        return False
    return stat[stat.rindex(")") + 2] != "Z"


# Writes a task_result and a ctx_call behind it in one write, bypassing
# the runner (whose `ctx` would refuse the call), then stays alive.
_FRAME_AFTER_RESULT = """
import asyncio, json, sys

async def run(inputs, ctx):
    result = {"type": "task_result", "id": "x", "ok": True, "output": "done"}
    late = {"type": "ctx_call", "id": "ctx-late", "method": "secrets.get", "args": {"name": "token"}}
    sys.stdout.write(json.dumps(result) + "\\n" + json.dumps(late) + "\\n")
    sys.stdout.flush()
    await asyncio.sleep(30)
"""

# Leaves a grandchild in a new session with stdin/stdout/stderr closed, so
# no pipe EOF or hangup ends it; only the supervisor's sweep can.
_DETACHED_GRANDCHILD = """
import os, time

async def run(inputs, ctx):
    r, w = os.pipe()
    if os.fork() == 0:
        os.setsid()
        if os.fork() == 0:
            for fd in (0, 1, 2):
                os.close(fd)
            os.write(w, str(os.getpid()).encode())
            os.close(w)
            time.sleep(300)
        os._exit(0)
    os.close(w)
    return {"pid": int(os.read(r, 32))}
"""

# Leaves a detached process behind that reads whatever reaches its stdin
# and answers every task_invoke it sees with a forged task_result.
_LEAVE_A_PROCESS = """
import json, os

async def run(inputs, ctx):
    pid = os.fork()
    if pid == 0:
        os.setsid()
        with open(inputs["leak"], "ab", buffering=0) as leak:
            while chunk := os.read(0, 65536):
                leak.write(chunk)
                for line in chunk.splitlines():
                    try:
                        msg = json.loads(line)
                    except ValueError:
                        continue
                    if msg.get("type") == "task_invoke":
                        forged = {"type": "task_result", "id": msg["id"], "ok": True, "output": "forged"}
                        os.write(1, (json.dumps(forged) + "\\n").encode())
        os._exit(0)
    return {"pid": pid}
"""

_ECHO = "async def run(inputs, ctx):\n    return {'echo': inputs}\n"

# Walks up from the task's process to the supervisor, trying to open each
# ancestor's stdin and stdout through /proc.
_OPEN_ANCESTOR_FDS = """
import os

def _ppid(pid):
    with open(f"/proc/{pid}/stat") as f:
        stat = f.read()
    return int(stat[stat.rindex(")") + 2:].split()[1])

async def run(inputs, ctx):
    opened = []
    pid = os.getpid()
    while pid != inputs["supervisor"] and pid > 1:
        pid = _ppid(pid)
        for fd, flags in ((0, os.O_RDONLY), (1, os.O_WRONLY)):
            try:
                os.close(os.open(f"/proc/{pid}/fd/{fd}", flags))
                opened.append(f"{pid}/{fd}")
            except PermissionError:
                pass
    return {"opened": opened}
"""


class TestTaskIsolation:
    def test_the_relay_forwards_nothing_after_the_task_result(self, sup: _Supervisor) -> None:
        sup.send_task("t-late", _FRAME_AFTER_RESULT, {})
        frames = sup.frames_until_exit()
        assert [f.get("type") for f in frames] == ["supervisor_ready", "task_result", "task_exited"]
        assert frames[1]["id"] == "t-late"

    def test_a_detached_grandchild_is_killed_before_task_exited(self, sup: _Supervisor) -> None:
        result = sup.run_task("t-detach", _DETACHED_GRANDCHILD, {})
        assert result["ok"] is True, result
        assert sup.await_exit("t-detach") == {"type": "task_exited", "id": "t-detach"}
        assert not _alive(result["output"]["pid"])

    def test_a_process_the_task_left_behind_is_gone_before_the_next_task(
        self, sup: _Supervisor, tmp_path: Path
    ) -> None:
        leak = tmp_path / "leak"
        result = sup.run_task("t-leave", _LEAVE_A_PROCESS, {"leak": str(leak)})
        assert result["ok"] is True, result
        leftover = result["output"]["pid"]
        assert sup.await_exit("t-leave") == {"type": "task_exited", "id": "t-leave"}

        after = sup.run_task("t-next", _ECHO, {"secret": "for-t-next-only"})

        assert after["output"] == {"echo": {"secret": "for-t-next-only"}}
        assert not _alive(leftover)
        assert not leak.exists() or b"for-t-next-only" not in leak.read_bytes()

    def test_the_task_runs_with_no_new_privs(self, sup: _Supervisor) -> None:
        body = "import ctypes\nasync def run(inputs, ctx):\n    return ctypes.CDLL(None).prctl(39, 0, 0, 0, 0)\n"
        # 39 = PR_GET_NO_NEW_PRIVS
        assert sup.run_task("t-nnp", body, {})["output"] == 1

    @pytest.mark.skipif(os.geteuid() == 0, reason="root holds CAP_SYS_PTRACE, which bypasses dumpability")
    def test_the_task_cannot_open_the_host_channel_through_proc(self, sup: _Supervisor) -> None:
        result = sup.run_task("t-proc", _OPEN_ANCESTOR_FDS, {"supervisor": sup.proc.pid})
        assert result["ok"] is True, result
        assert result["output"] == {"opened": []}


def _descendant_pids(root: int) -> list[int]:
    children: dict[int, list[int]] = {}
    for name in os.listdir("/proc"):
        if name.isdigit():
            try:
                with open(f"/proc/{name}/stat") as f:
                    stat = f.read()
            except OSError:
                continue
            children.setdefault(int(stat[stat.rindex(")") + 2 :].split()[1]), []).append(int(name))
    found: list[int] = []
    stack = [root]
    while stack:
        for child in children.get(stack.pop(), ()):
            found.append(child)
            stack.append(child)
    return found


class TestSupervisorProtocol:
    def test_announces_its_protocol_version_first(self, sup: _Supervisor) -> None:
        assert sup.next_frame(10) == {"type": "supervisor_ready", "protocolVersion": 2}

    def test_confirms_each_task_exited_and_serves_the_next(self, sup: _Supervisor) -> None:
        first = sup.run_task("t-1", _ECHO, {"n": 1})
        assert first["output"] == {"echo": {"n": 1}}
        assert sup.await_exit("t-1") == {"type": "task_exited", "id": "t-1"}
        second = sup.run_task("t-2", _ECHO, {"n": 2})
        assert second["output"] == {"echo": {"n": 2}}
        assert sup.await_exit("t-2") is not None

    def test_inherits_no_garbage_that_closes_the_tasks_fds(self, sup: _Supervisor) -> None:
        # Every task process is forked from the supervisor's heap. Garbage
        # there owning an fd would be finalized in the task after the fd
        # number was closed and reused, closing whatever the task opened.
        body = (
            "import gc, os\n"
            "async def run(inputs, ctx):\n"
            "    fds = [fd for _ in range(16) for fd in os.pipe()]\n"
            "    gc.collect()\n"
            "    closed = []\n"
            "    for fd in fds:\n"
            "        try:\n"
            "            os.fstat(fd)\n"
            "        except OSError:\n"
            "            closed.append(fd)\n"
            "    return {'closed': closed}\n"
        )
        for i in range(3):
            result = sup.run_task(f"t-{i}", body, {})
            assert result.get("output") == {"closed": []}, result
            assert sup.await_exit(f"t-{i}") is not None

    def test_stamps_ctx_calls_and_delivers_only_this_tasks_results(self, sup: _Supervisor) -> None:
        sup.send(
            {
                "type": "task_invoke",
                "id": "t-ctx",
                "skill": "ctx",
                "inputs": {},
                "body": "async def run(inputs, ctx):\n    return {'now': await ctx.now()}\n",
                "wallClockS": 5,
            }
        )
        call = sup.next_frame(5)
        while call is not None and call.get("type") != "ctx_call":
            call = sup.next_frame(5)
        assert call is not None
        assert call["taskId"] == "t-ctx"
        assert call["method"] == "now"
        sup.send({"type": "ctx_result", "taskId": "t-other", "id": call["id"], "ok": True, "value": "wrong"})
        sup.send({"type": "ctx_result", "taskId": "t-ctx", "id": call["id"], "ok": True, "value": "right"})
        result = sup.next_frame(5)
        assert result is not None
        assert result["type"] == "task_result"
        assert result["output"] == {"now": "right"}

    def test_fails_the_task_fast_on_a_ctx_result_without_a_task_id(self, sup: _Supervisor) -> None:
        # What a host that predates task binding sends.
        sup.send_task("t-old", "async def run(inputs, ctx):\n    return await ctx.now()\n", {}, wall_clock_s=30)
        call = sup.next_frame(5)
        while call is not None and call.get("type") != "ctx_call":
            call = sup.next_frame(5)
        assert call is not None
        sup.send({"type": "ctx_result", "id": call["id"], "ok": True, "value": "untagged"})
        frames = sup.frames_until_exit(timeout=5)
        assert frames[0] == {
            "type": "task_result",
            "id": "t-old",
            "ok": False,
            "error": "host_protocol_mismatch: ctx_result without taskId",
        }
        assert frames[-1] == {"type": "task_exited", "id": "t-old"}

    def test_exits_without_task_exited_when_the_sweep_cannot_empty_the_subtree(self) -> None:
        sup = _Supervisor(patch="supervisor._sweep_descendants = lambda deadline_s: False")
        try:
            result = sup.run_task("t-stuck", _ECHO, {})
            assert result["ok"] is True
            assert sup.frames_until_exit() == []
            assert sup.proc.wait(timeout=5) == 1
        finally:
            sup.close()

    def test_kills_a_relay_the_task_stopped_after_the_grace(self, sup: _Supervisor) -> None:
        body = (
            "import asyncio, os, signal\n"
            "async def run(inputs, ctx):\n"
            "    os.kill(os.getppid(), signal.SIGSTOP)\n"
            "    await asyncio.sleep(30)\n"
        )
        start = time.monotonic()
        sup.send_task("t-stop", body, {}, wall_clock_s=0.5)
        frames = sup.frames_until_exit(timeout=10)
        elapsed = time.monotonic() - start
        assert [f.get("type") for f in frames] == ["supervisor_ready", "task_exited"]
        # The stopped relay can't enforce the wall clock; the supervisor's
        # backstop fires RELAY_GRACE_S (2 s) after it.
        assert 2.5 <= elapsed < 8, elapsed
        assert sup.run_task("t-after", _ECHO, {})["ok"] is True

    def test_relays_a_ctx_result_the_size_of_an_http_body(self, sup: _Supervisor) -> None:
        sup.send(
            {
                "type": "task_invoke",
                "id": "t-big",
                "skill": "big",
                "inputs": {},
                "body": "async def run(inputs, ctx):\n    return {'len': len(await ctx.now())}\n",
                "wallClockS": 10,
            }
        )
        call = sup.next_frame(5)
        while call is not None and call.get("type") != "ctx_call":
            call = sup.next_frame(5)
        assert call is not None
        big = "x" * (5 * 1024 * 1024)
        sup.send({"type": "ctx_result", "taskId": "t-big", "id": call["id"], "ok": True, "value": big})
        result = sup.next_frame(10)
        assert result is not None
        assert result["output"] == {"len": len(big)}

    def test_fails_a_task_whose_frame_exceeds_the_cap(self, sup: _Supervisor) -> None:
        body = (
            "import asyncio, sys\n"
            "async def run(inputs, ctx):\n"
            "    sys.stdout.write('x' * (16 * 1024 * 1024 + 1))\n"
            "    sys.stdout.flush()\n"
            "    await asyncio.sleep(30)\n"
        )
        result = sup.run_task("t-flood", body, {}, wall_clock_s=10)
        assert result == {"type": "task_result", "id": "t-flood", "ok": False, "error": "task_frame_too_large"}
        assert sup.await_exit("t-flood") is not None

    def test_stamps_the_task_result_with_the_task_id(self, sup: _Supervisor) -> None:
        body = (
            "import asyncio, json, sys\n"
            "async def run(inputs, ctx):\n"
            "    sys.stdout.write(json.dumps({'type': 'task_result', 'id': 'someone-else', 'ok': True, "
            "'output': 'mine'}) + '\\n')\n"
            "    sys.stdout.flush()\n"
            "    await asyncio.sleep(30)\n"
        )
        result = sup.run_task("t-stamp", body, {})
        assert result["id"] == "t-stamp"
        assert sup.await_exit("t-stamp") is not None

    def test_wall_clock_kills_the_task(self, sup: _Supervisor) -> None:
        body = "import asyncio\nasync def run(inputs, ctx):\n    await asyncio.sleep(30)\n"
        result = sup.run_task("t-slow", body, {}, wall_clock_s=0.5)
        assert result == {"type": "task_result", "id": "t-slow", "ok": False, "error": "wall_clock_exceeded"}
        assert sup.await_exit("t-slow") is not None

    @pytest.mark.parametrize(
        ("body", "error"),
        [
            ("import os\nasync def run(inputs, ctx):\n    os._exit(139)\n", "child_died: exit=139"),
            (
                "import os, signal\nasync def run(inputs, ctx):\n    os.kill(os.getpid(), signal.SIGKILL)\n",
                "child_died: signal=9",
            ),
            (
                "import os, signal\nasync def run(inputs, ctx):\n    os.killpg(0, signal.SIGKILL)\n",
                "child_died: signal=9",
            ),
        ],
        ids=["exit", "signal", "own-process-group"],
    )
    def test_reports_a_task_process_that_died_without_a_result(
        self, sup: _Supervisor, body: str, error: str
    ) -> None:
        result = sup.run_task("t-die", body, {})
        assert result == {"type": "task_result", "id": "t-die", "ok": False, "error": error}
        assert sup.await_exit("t-die") is not None
        assert sup.run_task("t-after", _ECHO, {})["ok"] is True

    def test_confirms_exit_when_the_task_kills_its_relay(self, sup: _Supervisor) -> None:
        body = (
            "import asyncio, os, signal\n"
            "async def run(inputs, ctx):\n"
            "    os.kill(os.getppid(), signal.SIGKILL)\n"
            "    await asyncio.sleep(30)\n"
        )
        sup.send_task("t-relay", body, {}, wall_clock_s=30)
        frames = sup.frames_until_exit()
        assert {"type": "task_exited", "id": "t-relay"} in frames
        assert [f for f in frames if f.get("type") == "task_result"] == []
        assert sup.run_task("t-after", _ECHO, {})["ok"] is True

    def test_skips_a_stale_ctx_result_ahead_of_the_next_task(self, sup: _Supervisor) -> None:
        sup.run_task("t-1", _ECHO, {})
        assert sup.await_exit("t-1") is not None
        sup.send({"type": "ctx_result", "taskId": "t-1", "id": "ctx-stale", "ok": True, "value": 1})
        assert sup.run_task("t-2", _ECHO, {"n": 2})["output"] == {"echo": {"n": 2}}

    def test_shuts_down_on_eof_leaving_no_process_behind(self, sup: _Supervisor) -> None:
        sup.run_task("t-1", _ECHO, {})
        assert sup.await_exit("t-1") is not None
        # The supervisor forks the next task's relay and task process right
        # after `task_exited`; wait for both.
        deadline = time.monotonic() + 5
        while len(idle := _descendant_pids(sup.proc.pid)) < 2 and time.monotonic() < deadline:
            time.sleep(0.01)
        assert len(idle) == 2, idle
        sup.close()
        assert sup.proc.returncode == 0
        assert [pid for pid in idle if _alive(pid)] == []
