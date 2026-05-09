/**
 * Embedded Python source for the Tier-2 (sysbox container) skill runner.
 * Defines `_main(body, inputs, task_id)` — the per-task lifecycle. Two
 * callers wrap it:
 *
 *   - The supervisor (`supervisor.py.ts`) interpolates this source and
 *     calls `_main` from a forked child after reading `task_invoke` from
 *     stdin in the supervisor parent. Body / inputs / task_id come from
 *     the in-memory task dict. Used by both the warm pool and per-task
 *     one-shots (skills with resource overrides that bypass the pool).
 *
 *   - There is no stdin-driven `task_invoke` reader inside this module
 *     anymore — the supervisor always passes the task by argument. The
 *     stdin reader below only consumes `ctx_result` lines that resolve
 *     `await ctx.foo()` calls mid-task.
 *
 * Protocol — line-buffered NDJSON over stdin/stdout:
 *   - Resolves `await ctx.<method>(...)` by writing `ctx_call` to stdout
 *     and blocking on the matching `ctx_result` from stdin.
 *   - Writes one `task_result` to stdout. Then returns; the caller
 *     (supervisor child) exits.
 *
 * Multiple `ctx_call`s may be in flight (the host services them concurrently
 * and replies in any order); the runner correlates by `id`.
 */
export const RUNNER_PY: string = `
import asyncio
import inspect
import json
import sys
import traceback
import uuid


# stdout/stderr are line-buffered already because the host sets python -u.
# stdin reads happen via asyncio's StreamReader for non-blocking framing.


class CtxError(Exception):
    """Typed ctx error surfaced to user code. Mirrors Tier-1 ctx.py."""

    def __init__(self, kind, message):
        super().__init__(f"{kind}: {message}")
        self.kind = kind
        self.message = message


class _Bridge:
    """RPC plumbing between user code (\`await ctx.foo()\`) and the host.

    One bridge per task. Sends \`ctx_call\` to stdout, blocks the calling
    coroutine on a Future keyed by the call's correlation id, resolves the
    Future when the matching \`ctx_result\` arrives on stdin.
    """

    def __init__(self):
        self._pending = {}
        self._stdout_lock = asyncio.Lock()

    async def call(self, method, args):
        call_id = "ctx-" + uuid.uuid4().hex[:12]
        future = asyncio.get_running_loop().create_future()
        self._pending[call_id] = future
        await self._send({"type": "ctx_call", "id": call_id, "method": method, "args": args})
        return await future

    def deliver(self, message):
        """Called by the stdin reader when a ctx_result arrives."""
        call_id = message.get("id")
        future = self._pending.pop(call_id, None)
        if future is None or future.done():
            return
        if message.get("ok"):
            future.set_result(message.get("value"))
        else:
            future.set_exception(
                CtxError(
                    message.get("errorKind", "unknown"),
                    message.get("message", ""),
                )
            )

    def fail_pending(self, error):
        """Called when stdin closes mid-task — reject every outstanding ctx call."""
        for future in self._pending.values():
            if not future.done():
                future.set_exception(error)
        self._pending.clear()

    async def _send(self, obj):
        line = json.dumps(obj) + "\\n"
        async with self._stdout_lock:
            sys.stdout.write(line)
            sys.stdout.flush()


class _Secrets:
    def __init__(self, bridge):
        self._b = bridge

    async def get(self, name):
        return await self._b.call("secrets.get", {"name": name})


class _Memory:
    def __init__(self, bridge):
        self._b = bridge

    async def recall(self, query, limit=None):
        args = {"query": query}
        if limit is not None:
            args["limit"] = limit
        return await self._b.call("memory.recall", args)

    async def remember(self, content, tags=None):
        args = {"content": content}
        if tags is not None:
            args["tags"] = list(tags)
        return await self._b.call("memory.remember", args)


class _Files:
    def __init__(self, bridge):
        self._b = bridge

    async def read(self, path):
        return await self._b.call("files.read", {"path": path})

    async def write(self, path, content):
        return await self._b.call("files.write", {"path": path, "content": content})

    async def list(self, prefix=None):
        args = {}
        if prefix is not None:
            args["prefix"] = prefix
        result = await self._b.call("files.list", args)
        return result["entries"]


class _Log:
    def __init__(self, bridge):
        self._b = bridge

    async def info(self, message, **fields):
        return await self._b.call("log.info", {"message": message, "fields": fields})


class Ctx:
    """Host context object passed to \`async def run(inputs, ctx)\`."""

    def __init__(self, bridge):
        self._b = bridge
        self.secrets = _Secrets(bridge)
        self.memory = _Memory(bridge)
        self.files = _Files(bridge)
        self.log = _Log(bridge)

    async def now(self):
        return await self._b.call("now", {})

    async def user(self):
        return await self._b.call("user", {})


async def _read_stdin_lines(bridge):
    """Drain stdin during a task's run — only \`ctx_result\` shapes are
    expected; everything else is logged to stderr and dropped.
    """
    loop = asyncio.get_running_loop()
    reader = asyncio.StreamReader()
    protocol = asyncio.StreamReaderProtocol(reader)
    await loop.connect_read_pipe(lambda: protocol, sys.stdin)
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
            sys.stderr.write("ignoring malformed line\\n")
            continue
        kind = message.get("type")
        if kind == "ctx_result":
            bridge.deliver(message)
        # task_invoke / task_result / ctx_call are not expected here under
        # the supervisor model; drop silently to avoid coupling to host bugs.


def _send_sync(obj):
    """Synchronous send used after the event loop ends (final task_result)."""
    sys.stdout.write(json.dumps(obj) + "\\n")
    sys.stdout.flush()


async def _main(skill_body, inputs, task_id):
    """Per-task lifecycle. Compiles the skill body, runs
    \`async def run(inputs, ctx)\`, emits exactly one \`task_result\` line
    on stdout. Errors at any stage land as a non-ok task_result; the
    function does not raise to the caller.
    """
    bridge = _Bridge()
    stdin_task = asyncio.create_task(_read_stdin_lines(bridge))

    # Compile and run the user's skill body, expecting an \`async def run(inputs, ctx)\`.
    skill_module = {}
    try:
        exec(compile(skill_body, "<skill>", "exec"), skill_module)
    except SyntaxError as e:
        _send_sync({
            "type": "task_result",
            "id": task_id,
            "ok": False,
            "error": f"SyntaxError: {e.msg} (line {e.lineno})",
        })
        stdin_task.cancel()
        return

    run_fn = skill_module.get("run")
    if not callable(run_fn) or not inspect.iscoroutinefunction(run_fn):
        _send_sync({
            "type": "task_result",
            "id": task_id,
            "ok": False,
            "error": "skill must define \`async def run(inputs, ctx)\`",
        })
        stdin_task.cancel()
        return

    ctx = Ctx(bridge)
    try:
        output = await run_fn(inputs, ctx)
        _send_sync({"type": "task_result", "id": task_id, "ok": True, "output": output})
    except CtxError as e:
        _send_sync({
            "type": "task_result",
            "id": task_id,
            "ok": False,
            "error": f"{e.kind}: {e.message}",
        })
    except Exception as e:
        _send_sync({
            "type": "task_result",
            "id": task_id,
            "ok": False,
            "error": f"{type(e).__name__}: {e}",
            "traceback": traceback.format_exc(),
        })
    finally:
        stdin_task.cancel()
        try:
            await stdin_task
        except (asyncio.CancelledError, Exception):
            pass
`;
