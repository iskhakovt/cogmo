"""Per-task skill runner.

Imported by both the supervisor (forked child calls `_main`) and the
test suite (drives `_main` directly with fake streams). The runner
owns the NDJSON-on-stdin/stdout bridge for `await ctx.<method>(...)`
calls during a task and emits exactly one `task_result` line on
completion.

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
from collections.abc import Mapping, Sequence
from typing import Any, BinaryIO, TextIO


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


class CtxError(Exception):
    """Typed ctx error surfaced to user code. Mirrors Tier-1 ctx.py."""

    def __init__(self, kind: str, message: str) -> None:
        super().__init__(f"{kind}: {message}")
        self.kind = kind
        self.message = message


class _Bridge:
    """RPC plumbing between user code (`await ctx.foo()`) and the host.

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

    async def call(self, method: str, args: object) -> Any:
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


class _Secrets:
    def __init__(self, bridge: _Bridge) -> None:
        self._b = bridge

    async def get(self, name: str) -> Any:
        return await self._b.call("secrets.get", {"name": name})


class _Memory:
    def __init__(self, bridge: _Bridge) -> None:
        self._b = bridge

    async def recall(self, query: str, limit: int | None = None) -> Any:
        args: dict[str, object] = {"query": query}
        if limit is not None:
            args["limit"] = limit
        return await self._b.call("memory.recall", args)

    async def remember(self, content: str, tags: Sequence[str] | None = None) -> Any:
        args: dict[str, object] = {"content": content}
        if tags is not None:
            args["tags"] = list(tags)
        return await self._b.call("memory.remember", args)


class _Files:
    def __init__(self, bridge: _Bridge) -> None:
        self._b = bridge

    async def read(self, path: str) -> Any:
        return await self._b.call("files.read", {"path": path})

    async def write(self, path: str, content: str) -> Any:
        return await self._b.call("files.write", {"path": path, "content": content})

    async def list(self, prefix: str | None = None) -> Any:
        args: dict[str, object] = {}
        if prefix is not None:
            args["prefix"] = prefix
        result = await self._b.call("files.list", args)
        return result["entries"]


class _Http:
    """Outbound HTTP, performed by the host.

    Present in both tiers so a skill does not break when adding a
    dependency moves it here from tier 1. Tier 2 has real sockets and can
    use `httpx` instead; going through the host keeps the request in
    `skill_context_calls` and under the host's destination checks.
    """

    def __init__(self, bridge: _Bridge) -> None:
        self._b = bridge

    async def request(
        self,
        method: str,
        url: str,
        headers: dict[str, str] | None = None,
        body: str | None = None,
        timeout_ms: int | None = None,
    ) -> Any:
        args: dict[str, object] = {"method": method.upper(), "url": url}
        if headers is not None:
            args["headers"] = dict(headers)
        if body is not None:
            args["body"] = body
        if timeout_ms is not None:
            args["timeoutMs"] = timeout_ms
        return await self._b.call("http.request", args)

    async def get(
        self, url: str, headers: dict[str, str] | None = None, timeout_ms: int | None = None
    ) -> Any:
        return await self.request("GET", url, headers=headers, timeout_ms=timeout_ms)

    async def post(
        self,
        url: str,
        body: str | None = None,
        headers: dict[str, str] | None = None,
        timeout_ms: int | None = None,
    ) -> Any:
        return await self.request("POST", url, headers=headers, body=body, timeout_ms=timeout_ms)


class _Log:
    def __init__(self, bridge: _Bridge) -> None:
        self._b = bridge

    async def info(self, message: str, **fields: object) -> Any:
        return await self._b.call("log.info", {"message": message, "fields": fields})


class Ctx:
    """Host context object passed to `async def run(inputs, ctx)`."""

    def __init__(self, bridge: _Bridge) -> None:
        self._b = bridge
        self.secrets = _Secrets(bridge)
        self.memory = _Memory(bridge)
        self.files = _Files(bridge)
        self.http = _Http(bridge)
        self.log = _Log(bridge)

    async def now(self) -> Any:
        return await self._b.call("now", {})

    async def user(self) -> Any:
        return await self._b.call("user", {})


# Host caps an `http.request` body at 5 MiB; the frame carrying it needs
# room for that plus JSON escaping, which can inflate a body meaningfully.
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
            # the skill hangs until the supervisor's wall clock kills it.
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
        # task_invoke / task_result / ctx_call are not expected here under
        # the supervisor model; drop silently to avoid coupling to host bugs.


def _send_sync(stdout: TextIO, obj: Mapping[str, object]) -> None:
    """Synchronous send used after the event loop ends (final task_result)."""
    stdout.write(json.dumps(obj) + "\n")
    stdout.flush()


async def _main(
    skill_body: str,
    inputs: Any,
    task_id: str,
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
    skill_module: dict[str, object] = {}
    try:
        exec(compile(skill_body, "<skill>", "exec"), skill_module)
    except SyntaxError as e:
        _send_sync(
            out,
            {
                "type": "task_result",
                "id": task_id,
                "ok": False,
                "error": f"SyntaxError: {e.msg} (line {e.lineno})",
                "rusage": _current_rusage(),
            },
        )
        stdin_task.cancel()
        return

    run_fn = skill_module.get("run")
    if not callable(run_fn) or not inspect.iscoroutinefunction(run_fn):
        _send_sync(
            out,
            {
                "type": "task_result",
                "id": task_id,
                "ok": False,
                "error": "skill must define `async def run(inputs, ctx)`",
                "rusage": _current_rusage(),
            },
        )
        stdin_task.cancel()
        return

    ctx = Ctx(bridge)
    try:
        output = await run_fn(inputs, ctx)
        _send_sync(
            out,
            {
                "type": "task_result",
                "id": task_id,
                "ok": True,
                "output": output,
                "rusage": _current_rusage(),
            },
        )
    except CtxError as e:
        _send_sync(
            out,
            {
                "type": "task_result",
                "id": task_id,
                "ok": False,
                "error": f"{e.kind}: {e.message}",
                "rusage": _current_rusage(),
            },
        )
    except Exception as e:
        _send_sync(
            out,
            {
                "type": "task_result",
                "id": task_id,
                "ok": False,
                "error": f"{type(e).__name__}: {e}",
                "traceback": traceback.format_exc(),
                "rusage": _current_rusage(),
            },
        )
    finally:
        stdin_task.cancel()
        try:
            await stdin_task
        except (asyncio.CancelledError, Exception):
            pass
