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
import sys
import traceback
import uuid
from typing import Any, TextIO


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
        self._pending: dict[str, asyncio.Future[Any]] = {}
        self._stdout_lock = asyncio.Lock()
        self._stdout = stdout

    async def call(self, method: str, args: Any) -> Any:
        call_id = "ctx-" + uuid.uuid4().hex[:12]
        future: asyncio.Future[Any] = asyncio.get_running_loop().create_future()
        self._pending[call_id] = future
        await self._send({"type": "ctx_call", "id": call_id, "method": method, "args": args})
        return await future

    def deliver(self, message: dict[str, Any]) -> None:
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

    async def _send(self, obj: dict[str, Any]) -> None:
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
        args: dict[str, Any] = {"query": query}
        if limit is not None:
            args["limit"] = limit
        return await self._b.call("memory.recall", args)

    async def remember(self, content: str, tags: list[str] | None = None) -> Any:
        args: dict[str, Any] = {"content": content}
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
        args: dict[str, Any] = {}
        if prefix is not None:
            args["prefix"] = prefix
        result = await self._b.call("files.list", args)
        return result["entries"]


class _Log:
    def __init__(self, bridge: _Bridge) -> None:
        self._b = bridge

    async def info(self, message: str, **fields: Any) -> Any:
        return await self._b.call("log.info", {"message": message, "fields": fields})


class Ctx:
    """Host context object passed to `async def run(inputs, ctx)`."""

    def __init__(self, bridge: _Bridge) -> None:
        self._b = bridge
        self.secrets = _Secrets(bridge)
        self.memory = _Memory(bridge)
        self.files = _Files(bridge)
        self.log = _Log(bridge)

    async def now(self) -> Any:
        return await self._b.call("now", {})

    async def user(self) -> Any:
        return await self._b.call("user", {})


async def _read_stdin_lines(bridge: _Bridge, stdin: Any, stderr: TextIO) -> None:
    """Drain stdin during a task's run — only `ctx_result` shapes are
    expected; everything else is logged to stderr and dropped.
    """
    loop = asyncio.get_running_loop()
    reader = asyncio.StreamReader()
    protocol = asyncio.StreamReaderProtocol(reader)
    await loop.connect_read_pipe(lambda: protocol, stdin)
    while True:
        line = await reader.readline()
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


def _send_sync(stdout: TextIO, obj: dict[str, Any]) -> None:
    """Synchronous send used after the event loop ends (final task_result)."""
    stdout.write(json.dumps(obj) + "\n")
    stdout.flush()


async def _main(
    skill_body: str,
    inputs: Any,
    task_id: str,
    *,
    stdin: Any | None = None,
    stdout: TextIO | None = None,
    stderr: TextIO | None = None,
) -> None:
    """Per-task lifecycle. Compiles the skill body, runs
    `async def run(inputs, ctx)`, emits exactly one `task_result` line
    on stdout. Errors at any stage land as a non-ok task_result; the
    function does not raise to the caller.

    Streams default to `sys.stdin`/`stdout`/`stderr`; tests pass fakes.
    """
    out = stdout if stdout is not None else sys.stdout
    err = stderr if stderr is not None else sys.stderr
    inp = stdin if stdin is not None else sys.stdin

    bridge = _Bridge(out)
    stdin_task = asyncio.create_task(_read_stdin_lines(bridge, inp, err))

    # Compile and run the user's skill body, expecting an `async def run(inputs, ctx)`.
    skill_module: dict[str, Any] = {}
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
            },
        )
        stdin_task.cancel()
        return

    ctx = Ctx(bridge)
    try:
        output = await run_fn(inputs, ctx)
        _send_sync(out, {"type": "task_result", "id": task_id, "ok": True, "output": output})
    except CtxError as e:
        _send_sync(
            out,
            {
                "type": "task_result",
                "id": task_id,
                "ok": False,
                "error": f"{e.kind}: {e.message}",
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
            },
        )
    finally:
        stdin_task.cancel()
        try:
            await stdin_task
        except asyncio.CancelledError, Exception:
            pass
