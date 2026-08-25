/**
 * Embedded Python source for the Tier-1 `ctx` SDK. Materialized into the
 * Pyodide instance at worker boot via `pyodide.runPythonAsync`. Kept in TS
 * (rather than a `.py` resource) so it ships inside the bundled `dist/` tree
 * with no extra build step and is co-located with its only consumer.
 *
 * Skills declare `async def run(inputs, ctx)`; ctx methods return JsPromise
 * objects that Pyodide makes awaitable in Python. This avoids the
 * SharedArrayBuffer + Atomics.wait dance a sync ctx API would require.
 */
export const CTX_PY: string = `
class CtxError(Exception):
    """Base class for typed ctx errors raised by the host."""
    def __init__(self, kind, message):
        super().__init__(f"{kind}: {message}")
        self.kind = kind
        self.message = message


class _Secrets:
    def __init__(self, ctx):
        self._ctx = ctx

    async def get(self, name):
        return await self._ctx._call("secrets.get", {"name": name})


class _Memory:
    def __init__(self, ctx):
        self._ctx = ctx

    async def recall(self, query, limit=None):
        args = {"query": query}
        if limit is not None:
            args["limit"] = limit
        return await self._ctx._call("memory.recall", args)

    async def remember(self, content, tags=None):
        args = {"content": content}
        if tags is not None:
            args["tags"] = list(tags)
        return await self._ctx._call("memory.remember", args)


class _Files:
    def __init__(self, ctx):
        self._ctx = ctx

    async def read(self, path):
        return await self._ctx._call("files.read", {"path": path})

    async def write(self, path, content):
        return await self._ctx._call("files.write", {"path": path, "content": content})

    async def list(self, prefix=None):
        args = {}
        if prefix is not None:
            args["prefix"] = prefix
        result = await self._ctx._call("files.list", args)
        return result["entries"]


class _Http:
    """Outbound HTTP, performed by the host.

    Pyodide has no sockets, so \`urllib\` and \`http.client\` cannot reach the
    network from inside the sandbox — these methods are the way a tier-1
    skill makes a request. Responses come back as a dict with \`status\`,
    \`headers\` and \`body\`; a 4xx or 5xx arrives as a normal return value
    with that status, and only a failure to obtain a response at all
    raises.
    """

    def __init__(self, ctx):
        self._ctx = ctx

    async def request(self, method, url, headers=None, body=None, timeout_ms=None):
        args = {"method": method.upper(), "url": url}
        if headers is not None:
            args["headers"] = dict(headers)
        if body is not None:
            args["body"] = body
        if timeout_ms is not None:
            args["timeoutMs"] = timeout_ms
        return await self._ctx._call("http.request", args)

    async def get(self, url, headers=None, timeout_ms=None):
        return await self.request("GET", url, headers=headers, timeout_ms=timeout_ms)

    async def post(self, url, body=None, headers=None, timeout_ms=None):
        return await self.request("POST", url, headers=headers, body=body, timeout_ms=timeout_ms)


class _Log:
    def __init__(self, ctx):
        self._ctx = ctx

    async def info(self, message, **fields):
        return await self._ctx._call("log.info", {"message": message, "fields": fields})


class Ctx:
    """Host context object passed to async def run(inputs, ctx)."""
    def __init__(self, bridge):
        self._bridge = bridge
        self.secrets = _Secrets(self)
        self.memory = _Memory(self)
        self.files = _Files(self)
        self.http = _Http(self)
        self.log = _Log(self)

    async def _call(self, method, args):
        from pyodide.ffi import to_js
        from js import Object
        # Convert Python dict -> plain JS object so structured clone passes
        # cleanly through postMessage.
        js_args = to_js(args, dict_converter=Object.fromEntries)
        result = await self._bridge.call(method, js_args)
        # Result may be a JsProxy (e.g. recall returns an object). Call
        # .to_py() recursively if it's a proxy.
        try:
            return result.to_py()
        except AttributeError:
            return result

    async def now(self):
        return await self._call("now", {})

    async def user(self):
        return await self._call("user", {})


def _build_ctx(bridge):
    """Called by the worker entry to construct the per-task Ctx."""
    return Ctx(bridge)
`;
