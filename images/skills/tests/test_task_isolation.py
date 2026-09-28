"""Black-box tests of the supervisor protocol and task isolation.

Each test runs the real `python -m cogmo_skills_runtime` as a subprocess
and speaks the host protocol over its stdin/stdout, the way the TS
worker does. `TestTaskIsolation` pins what one task must not be able to
do to the next task on the same supervisor: reach the host after its
result, outlive its own teardown, read the next task's input, forge
frames, or open the supervisor's host channel through `/proc`.
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
    """A supervisor subprocess plus a reader thread queueing its stdout frames."""

    def __init__(self) -> None:
        env = dict(os.environ)
        env["PYTHONPATH"] = _SRC_DIR
        self.proc = subprocess.Popen(
            [sys.executable, "-u", "-m", "cogmo_skills_runtime"],
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

    def frames_for(self, seconds: float) -> list[dict[str, Any]]:
        """Every frame arriving within `seconds`."""
        out: list[dict[str, Any]] = []
        while (frame := self.next_frame(seconds)) is not None:
            out.append(frame)
        return out

    def run_task(self, task_id: str, body: str, inputs: object, wall_clock_s: float = 5) -> dict[str, Any]:
        """Send a task and return its `task_result`, answering no ctx calls."""
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


# The runner cancels leftover asyncio tasks when `run` returns; this one
# swallows the cancel and calls `ctx` after the result is out.
_LATE_CTX_CALL = """
import asyncio

async def _linger(ctx):
    while True:
        try:
            await asyncio.sleep(0.05)
            break
        except asyncio.CancelledError:
            continue
    await ctx.log.info("late")

async def run(inputs, ctx):
    asyncio.get_running_loop().create_task(_linger(ctx))
    return {"done": True}
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
    def test_no_ctx_call_reaches_the_host_after_the_task_result(self, sup: _Supervisor) -> None:
        result = sup.run_task("t-late", _LATE_CTX_CALL, {})
        assert result["ok"] is True, result
        after = sup.frames_for(1.0)
        assert [f for f in after if f.get("type") == "ctx_call"] == []

    def test_a_process_the_task_left_behind_is_gone_before_the_next_task(
        self, sup: _Supervisor, tmp_path: Path
    ) -> None:
        leak = tmp_path / "leak"
        result = sup.run_task("t-leave", _LEAVE_A_PROCESS, {"leak": str(leak)})
        assert result["ok"] is True, result
        leftover = result["output"]["pid"]
        sup.await_exit("t-leave", timeout=1.0)

        after = sup.run_task("t-next", _ECHO, {"secret": "for-t-next-only"})

        assert after["output"] == {"echo": {"secret": "for-t-next-only"}}
        assert not _alive(leftover)
        assert not leak.exists() or b"for-t-next-only" not in leak.read_bytes()

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
        sup.send({"type": "ctx_result", "id": call["id"], "ok": True, "value": "untagged"})
        sup.send({"type": "ctx_result", "taskId": "t-ctx", "id": call["id"], "ok": True, "value": "right"})
        result = sup.next_frame(5)
        assert result is not None
        assert result["type"] == "task_result"
        assert result["output"] == {"now": "right"}

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
        sup.send(
            {
                "type": "task_invoke",
                "id": "t-relay",
                "skill": "relay",
                "inputs": {},
                "body": (
                    "import asyncio, os, signal\n"
                    "async def run(inputs, ctx):\n"
                    "    os.kill(os.getppid(), signal.SIGKILL)\n"
                    "    await asyncio.sleep(30)\n"
                ),
                "wallClockS": 30,
            }
        )
        frames: list[dict[str, Any]] = []
        while (frame := sup.next_frame(5)) is not None:
            frames.append(frame)
            if frame.get("type") == "task_exited":
                break
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
