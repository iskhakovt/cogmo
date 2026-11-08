"""Per-task skill runner.

Imported by both the supervisor (the task process calls `_main`) and
the test suite (drives `_main` directly with fake streams). The runner
owns the NDJSON-on-stdin/stdout bridge for `await ctx.<method>(...)`
calls during a task and emits exactly one `task_result` line on
completion, after which `ctx` refuses every call. In the task process
stdin/stdout are private pipes to the task's relay.

Multiple `ctx_call`s may be in flight from the user's coroutine at the
same time; the bridge correlates host replies by `id`.
"""

import asyncio
import inspect
import json
import resource
import sys
import traceback
import uuid
from collections.abc import Mapping
from typing import Any, BinaryIO, TextIO

from cogmo_ctx import Ctx, CtxError, RunInfo
from cogmo_ctx._run import call_run


def _current_rusage() -> dict[str, int]:
    """Snapshot the current process's resource usage as a JSON-serialisable dict.

    Called immediately before each `task_result` emit so the host gets the
    child's peak memory at completion time. Linux `ru_maxrss` is reported
    in kilobytes; we scale to bytes for protocol consistency. macOS would
    report bytes already — irrelevant in practice since the production
    runtime is Linux containers, but we don't unit-test this on macOS for
    that reason.
    """
    ru = resource.getrusage(resource.RUSAGE_SELF)
    return {"peakMemoryBytes": int(ru.ru_maxrss) * 1024}


class _Bridge:
    """The container tier's `cogmo_ctx.Bridge`, over the task's private pipes.

    One bridge per task. Sends `ctx_call` to stdout, blocks the calling
    coroutine on a Future keyed by the call's correlation id, resolves
    the Future when the matching `ctx_result` arrives on stdin.
    """

    def __init__(self, stdout: TextIO) -> None:
        # `Future[Any]` (not `object`) because the resolved value flows
        # back to skill-author code via `await ctx.foo()`, which expects
        # to operate on it without isinstance gymnastics. Any opt-out is
        # the right shape at this boundary.
        self._pending: dict[str, asyncio.Future[Any]] = {}
        self._stdout_lock = asyncio.Lock()
        self._stdout = stdout
        self._closed = False

    def close(self) -> None:
        """End of task: every later `ctx` call raises `CtxError("task_finished")`."""
        self._closed = True

    async def call(self, method: str, args: Mapping[str, object]) -> Any:
        if self._closed:
            raise CtxError("task_finished", f"ctx.{method} called after the task returned")
        call_id = "ctx-" + uuid.uuid4().hex[:12]
        future: asyncio.Future[Any] = asyncio.get_running_loop().create_future()
        self._pending[call_id] = future
        await self._send({"type": "ctx_call", "id": call_id, "method": method, "args": args})
        return await future

    def deliver(self, message: Mapping[str, object]) -> None:
        """Called by the stdin reader when a ctx_result arrives."""
        call_id = message.get("id")
        if not isinstance(call_id, str):
            return
        future = self._pending.pop(call_id, None)
        if future is None or future.done():
            return
        if message.get("ok"):
            future.set_result(message.get("value"))
        else:
            future.set_exception(
                CtxError(
                    str(message.get("errorKind", "unknown")),
                    str(message.get("message", "")),
                )
            )

    def fail_pending(self, error: BaseException) -> None:
        """Called when stdin closes mid-task — reject every outstanding ctx call."""
        for future in self._pending.values():
            if not future.done():
                future.set_exception(error)
        self._pending.clear()

    async def _send(self, obj: Mapping[str, object]) -> None:
        line = json.dumps(obj) + "\n"
        async with self._stdout_lock:
            self._stdout.write(line)
            self._stdout.flush()


# Host caps an `http.request` body at 5 MiB; the frame carrying it needs
# room for that plus JSON escaping, which can inflate a body meaningfully.
# The relay's `MAX_FRAME_BYTES` (supervisor.py) is the same cap on what this
# process writes, which `_encode_output` checks an output against: keep the
# two equal.
_MAX_FRAME_BYTES = 16 * 1024 * 1024


async def _read_stdin_lines(bridge: _Bridge, stdin: BinaryIO, stderr: TextIO) -> None:
    """Drain stdin during a task's run — only `ctx_result` shapes are
    expected; everything else is logged to stderr and dropped.
    """
    loop = asyncio.get_running_loop()
    # `asyncio.StreamReader()` defaults to a 64 KiB line limit, and
    # `readline` raises once a frame passes it. A `ctx_result` carrying an
    # `http.request` body runs to the host's 5 MiB response cap, so the
    # frame limit has to clear that plus JSON overhead or ordinary API
    # responses break the transport rather than the skill.
    reader = asyncio.StreamReader(limit=_MAX_FRAME_BYTES)
    protocol = asyncio.StreamReaderProtocol(reader)
    await loop.connect_read_pipe(lambda: protocol, stdin)
    while True:
        try:
            line = await reader.readline()
        except Exception as exc:
            # A frame past `_MAX_FRAME_BYTES` makes `readline` raise, and
            # letting that escape kills this task silently: nothing calls
            # `fail_pending`, so an awaiting `ctx.*` call never returns and
            # the skill hangs until the relay's wall clock kills it.
            # Surfacing it as a failed call turns a hang into an error the
            # skill can catch. The read stream is unusable afterwards —
            # the oversized frame is still buffered — so this returns
            # rather than trying to resynchronise.
            stderr.write(f"stdin read failed: {exc}\n")
            bridge.fail_pending(RuntimeError(f"host frame unreadable: {exc}"))
            return
        if not line:
            # EOF — host closed stdin. Reject any pending ctx calls so user
            # code unblocks and the task can shut down.
            bridge.fail_pending(RuntimeError("stdin closed by host"))
            return
        try:
            message = json.loads(line.decode("utf-8"))
        except json.JSONDecodeError:
            stderr.write("ignoring malformed line\n")
            continue
        if not isinstance(message, dict):
            continue
        kind = message.get("type")
        if kind == "ctx_result":
            bridge.deliver(message)
        # The relay delivers only this task's ctx_results; anything else is
        # dropped.


def _emit_result(bridge: _Bridge, stdout: TextIO, result: Mapping[str, object]) -> None:
    """Emit the task's one `task_result`, closing `ctx` first so nothing
    the skill left running reaches the host after it.
    """
    bridge.close()
    stdout.write(json.dumps(result, allow_nan=False) + "\n")
    stdout.flush()


def _emit_failure(bridge: _Bridge, stdout: TextIO, task_id: str, error_kind: str, error: str) -> None:
    """Emit a failed `task_result`; `error_kind` is a run error kind the host accepts."""
    _emit_result(
        bridge,
        stdout,
        {
            "type": "task_result",
            "id": task_id,
            "ok": False,
            "errorKind": error_kind,
            "error": error,
            "rusage": _current_rusage(),
        },
    )


# What a result frame carries beyond its output: type, id, ok and rusage.
_RESULT_FRAME_OVERHEAD_BYTES = 64 * 1024

# The largest integer the host's JSON.parse carries exactly.
_MAX_SAFE_INTEGER = 2**53 - 1


def _unsafe(value: object) -> str | None:
    """Why JSON would not carry `value` to the host intact, or None.

    An integer past 2**53 the host's `JSON.parse` would round; two keys of
    one dict that JSON writes alike (`1` and `"1"`) it would keep only one of.
    """
    pending = [value]
    while pending:
        item = pending.pop()
        if isinstance(item, bool):
            continue
        if isinstance(item, int):
            if abs(item) > _MAX_SAFE_INTEGER:
                return f"integer {item} is past 2**53, which JSON rounds; return it as a string"
        elif isinstance(item, dict):
            names = {key if isinstance(key, str) else json.dumps(key) for key in item}
            if len(names) < len(item):
                return "two keys of one dict are written alike as JSON strings, so one would be lost"
            pending.extend(item.values())
        elif isinstance(item, list | tuple):
            pending.extend(item)
    return None


def _encode_output(output: object) -> str:
    """The output as JSON, or raise if JSON cannot carry it or the frame could not.

    `allow_nan=False` refuses `NaN` and the infinities, which `json.dumps`
    would otherwise write as tokens JSON does not have; a `set` or another
    unknown type raises `TypeError`, a cycle `ValueError`, and what the host
    would change (`_unsafe`) `ValueError`. The default
    `ensure_ascii` makes the length the byte count the relay's frame cap
    counts.
    """
    encoded = json.dumps(output, allow_nan=False)
    unsafe = _unsafe(output)
    if unsafe is not None:
        raise ValueError(unsafe)
    limit = _MAX_FRAME_BYTES - _RESULT_FRAME_OVERHEAD_BYTES
    if len(encoded) > limit:
        raise ValueError(f"output is {len(encoded)} bytes as JSON; the cap is {limit}")
    return encoded


def _emit_kept_output(bridge: _Bridge, stdout: TextIO, task_id: str, error: str, encoded: str) -> None:
    """Emit an `output_invalid` `task_result` that keeps what the skill returned, already encoded."""
    bridge.close()
    head = json.dumps(
        {
            "type": "task_result",
            "id": task_id,
            "ok": False,
            "errorKind": "output_invalid",
            "error": error,
            "rusage": _current_rusage(),
        }
    )
    stdout.write(f'{head[:-1]}, "output": {encoded}}}\n')
    stdout.flush()


def _emit_output(bridge: _Bridge, stdout: TextIO, task_id: str, encoded: str) -> None:
    """Emit a successful `task_result` carrying the already-encoded output."""
    bridge.close()
    head = json.dumps({"type": "task_result", "id": task_id, "ok": True, "rusage": _current_rusage()})
    stdout.write(f'{head[:-1]}, "output": {encoded}}}\n')
    stdout.flush()


def _kept_output(output: object, error: str) -> str | None:
    """`output` encoded for an `output_invalid` frame beside `error`, or None when it would not fit.

    JSON that cannot carry the output, a frame the message and the output together would overflow, and
    memory that runs out while encoding all keep nothing: the run is `output_invalid` either way.
    """
    if output is None:
        return None
    try:
        encoded = _encode_output(output)
    except TypeError, ValueError, RecursionError, MemoryError:
        return None
    limit = _MAX_FRAME_BYTES - _RESULT_FRAME_OVERHEAD_BYTES
    return encoded if len(encoded) + len(json.dumps(error)) <= limit else None


async def _main(
    skill_body: str,
    inputs: Any,
    task_id: str,
    run: RunInfo,
    *,
    stdin: BinaryIO | None = None,
    stdout: TextIO | None = None,
    stderr: TextIO | None = None,
) -> None:
    """Per-task lifecycle. Compiles the skill body, runs
    `async def run(inputs, ctx)`, emits exactly one `task_result` line
    on stdout. Errors at any stage land as a non-ok task_result; the
    function does not raise to the caller.

    Streams default to `sys.stdin.buffer` (binary) / `sys.stdout` /
    `sys.stderr`; tests pass fakes. `inputs` stays `Any` because it flows
    opaquely into user skill code, where the skill author's typechecker
    (not ours) decides the shape.

    `sys.stdin.buffer` (not `sys.stdin`) is what asyncio recommends for
    `connect_read_pipe`: the text-mode `TextIOWrapper` adds an extra
    decode layer asyncio doesn't use, and using a binary file-like is
    what asyncio's documented contract asks for.
    """
    out = stdout if stdout is not None else sys.stdout
    err = stderr if stderr is not None else sys.stderr
    inp = stdin if stdin is not None else sys.stdin.buffer

    bridge = _Bridge(out)
    stdin_task = asyncio.create_task(_read_stdin_lines(bridge, inp, err))

    # Compile and run the user's skill body, expecting an `async def run(inputs, ctx)`.
    # Anything the body raises at import time is a load failure, as a
    # syntax error is.
    skill_module: dict[str, object] = {}
    try:
        exec(compile(skill_body, "<skill>", "exec"), skill_module)
    except SyntaxError as e:
        _emit_failure(bridge, out, task_id, "load_failed", f"SyntaxError: {e.msg} (line {e.lineno})")
        stdin_task.cancel()
        return
    except MemoryError as e:
        _emit_failure(bridge, out, task_id, "memory_exceeded", f"MemoryError: {e}")
        stdin_task.cancel()
        return
    except Exception as e:
        _emit_failure(bridge, out, task_id, "load_failed", f"{type(e).__name__}: {e}")
        stdin_task.cancel()
        return

    run_fn = skill_module.get("run")
    if not callable(run_fn) or not inspect.iscoroutinefunction(run_fn):
        _emit_failure(bridge, out, task_id, "load_failed", "skill must define `async def run(inputs, ctx)`")
        stdin_task.cancel()
        return

    ctx = Ctx(bridge, run)
    try:
        failure, output = await call_run(skill_module, run_fn, inputs, ctx)
    except CtxError as e:
        _emit_failure(bridge, out, task_id, "skill_raised", f"{e.kind}: {e.message}")
    except MemoryError as e:
        _emit_failure(bridge, out, task_id, "memory_exceeded", f"MemoryError: {e}")
    except Exception as e:
        # The stack reaches the host's log through stderr; the result carries the message.
        err.write(traceback.format_exc())
        _emit_failure(bridge, out, task_id, "skill_raised", f"{type(e).__name__}: {e}")
    else:
        if failure is not None:
            kind, message = failure
            kept = _kept_output(output, message) if kind == "output_invalid" else None
            if kept is None:
                _emit_failure(bridge, out, task_id, kind, message)
            else:
                _emit_kept_output(bridge, out, task_id, message, kept)
            return
        try:
            encoded = _encode_output(output)
        except MemoryError as e:
            _emit_failure(bridge, out, task_id, "memory_exceeded", f"MemoryError: {e}")
        except Exception as e:
            _emit_failure(bridge, out, task_id, "output_invalid", f"output is not JSON: {e}")
        else:
            _emit_output(bridge, out, task_id, encoded)
    finally:
        stdin_task.cancel()
        try:
            await stdin_task
        except asyncio.CancelledError, Exception:
            pass
