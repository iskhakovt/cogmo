/**
 * Embedded Python source for the Tier-2 (sysbox container) skill runner.
 * Materialized at exec time as the `python3 -u -c <SOURCE>` argument, mirroring
 * how Tier 1 inlines `ctx.py.ts` into Pyodide via `runPythonAsync`. Keeps the
 * runtime in TS (no separate `.py` resource to ship and locate inside the
 * container image).
 *
 * Protocol: line-buffered NDJSON over stdin/stdout.
 *   - Reads one `task_invoke` from stdin (the host sends exactly one).
 *   - Resolves `await ctx.<method>(...)` calls by writing `ctx_call` to stdout
 *     and blocking on the matching `ctx_result` from stdin.
 *   - Writes one `task_result` to stdout. Then exits.
 *
 * Multiple `ctx_call`s may be in flight (the host services them concurrently
 * and replies in any order); the runner correlates by `id`.
 */
export const RUNNER_PY: string = `
import asyncio
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
        future = asyncio.get_event_loop().create_future()
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


async def _read_stdin_lines(bridge, task_invoke_future):
    """Drain stdin, route each line to the right place.

    The first \`task_invoke\` resolves the \`task_invoke_future\`; subsequent
    \`ctx_result\`s deliver through the bridge. Any other shape is logged to
    stderr and ignored.
    """
    loop = asyncio.get_event_loop()
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
        if kind == "task_invoke":
            if not task_invoke_future.done():
                task_invoke_future.set_result(message)
        elif kind == "ctx_result":
            bridge.deliver(message)
        # task_result and ctx_call are worker-emitted shapes; if we see them
        # on stdin it's a host bug. Drop silently rather than crashing.


def _send(obj):
    """Synchronous send used after the event loop ends (final task_result)."""
    sys.stdout.write(json.dumps(obj) + "\\n")
    sys.stdout.flush()


async def _main(skill_body):
    bridge = _Bridge()
    loop = asyncio.get_event_loop()
    task_invoke_future = loop.create_future()
    stdin_task = asyncio.create_task(_read_stdin_lines(bridge, task_invoke_future))

    invoke = await task_invoke_future
    task_id = invoke["id"]
    inputs = invoke["inputs"]

    # Compile and run the user's skill body, expecting an \`async def run(inputs, ctx)\`.
    skill_module = {}
    try:
        exec(compile(skill_body, "<skill>", "exec"), skill_module)
    except SyntaxError as e:
        _send({
            "type": "task_result",
            "id": task_id,
            "ok": False,
            "error": f"SyntaxError: {e.msg} (line {e.lineno})",
        })
        stdin_task.cancel()
        return

    run_fn = skill_module.get("run")
    if not callable(run_fn) or not asyncio.iscoroutinefunction(run_fn):
        _send({
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
        _send({"type": "task_result", "id": task_id, "ok": True, "output": output})
    except CtxError as e:
        _send({
            "type": "task_result",
            "id": task_id,
            "ok": False,
            "error": f"{e.kind}: {e.message}",
        })
    except Exception as e:
        _send({
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


# The host appends the user's skill body as a JSON-encoded string assigned
# to \`__skill_body__\` immediately before running this module via -c.
asyncio.run(_main(__skill_body__))
`;
