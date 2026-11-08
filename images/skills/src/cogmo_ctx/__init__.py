"""The `ctx` a skill's `async def run(inputs, ctx)` receives, on both tiers.

Each method is an async call to the host through the tier's `Bridge`: the
container tier's relay pipe (`cogmo_skills_runtime.runner`), the wasm tier's
`MessagePort` (`src/skills/worker-wasm/py/task.py` in Cogmo). Pure Python,
so the skills image installs this file and the wasm child embeds it.
"""

from collections.abc import Mapping, Sequence
from typing import TypedDict

from cogmo_ctx._contract import Bridge, CtxErrorKind, FileEntry, HttpResponse, MemoryRecall, User

__all__ = [
    "Bridge",
    "Ctx",
    "CtxError",
    "CtxErrorKind",
    "FileEntry",
    "HttpResponse",
    "MemoryRecall",
    "RunInfo",
    "SkillError",
    "User",
]


class CtxError(Exception):
    """The host refused a ctx call.

    `kind` says why: a `CtxErrorKind`, or `task_finished` for a call made after `run` returned.
    """

    def __init__(self, kind: str, message: str) -> None:
        super().__init__(f"{kind}: {message}")
        self.kind = kind
        self.message = message


class SkillError(Exception):
    """A failure the skill expects and reports as its result.

    The run finishes as `skill_failed`, or as `skill_retryable` with
    `retryable=True`, for a failure that may clear on a later attempt (an
    upstream outage, a rate limit). Any other exception out of `run` is a
    defect in the skill.
    """

    def __init__(self, kind: str, message: str, *, retryable: bool = False) -> None:
        super().__init__(f"{kind}: {message}")
        self.kind = kind
        self.message = message
        self.retryable = retryable


class RunInfo(TypedDict):
    """The run a task belongs to: its id, and the invocation's logical key."""

    id: str
    key: str


class _Secrets:
    def __init__(self, bridge: Bridge) -> None:
        self._b = bridge

    async def get(self, name: str) -> str:
        return await self._b.call("secrets.get", {"name": name})


class _Memory:
    def __init__(self, bridge: Bridge) -> None:
        self._b = bridge

    async def recall(self, query: str, limit: int | None = None) -> MemoryRecall:
        args: dict[str, object] = {"query": query}
        if limit is not None:
            args["limit"] = limit
        return await self._b.call("memory.recall", args)

    async def remember(self, content: str, tags: Sequence[str] | None = None) -> None:
        args: dict[str, object] = {"content": content}
        if tags is not None:
            args["tags"] = list(tags)
        return await self._b.call("memory.remember", args)


class _Files:
    def __init__(self, bridge: Bridge) -> None:
        self._b = bridge

    async def read(self, path: str) -> str:
        return await self._b.call("files.read", {"path": path})

    async def write(self, path: str, content: str) -> None:
        return await self._b.call("files.write", {"path": path, "content": content})

    async def list(self, prefix: str | None = None) -> list[FileEntry]:
        args: dict[str, object] = {}
        if prefix is not None:
            args["prefix"] = prefix
        result = await self._b.call("files.list", args)
        return result["entries"]


class _Http:
    """Outbound HTTP, performed by the host.

    The wasm tier's only network path: Pyodide has no sockets. The container
    tier can use `httpx` instead; this path keeps a skill working when a
    dependency moves it across tiers. A 4xx or 5xx is a value, a dict with
    `status`, `headers` and `body`; only a failure to get a response raises.
    """

    def __init__(self, bridge: Bridge) -> None:
        self._b = bridge

    async def request(
        self,
        method: str,
        url: str,
        headers: Mapping[str, str] | None = None,
        body: str | None = None,
        timeout_ms: int | None = None,
    ) -> HttpResponse:
        args: dict[str, object] = {"method": method.upper(), "url": url}
        if headers is not None:
            args["headers"] = dict(headers)
        if body is not None:
            args["body"] = body
        if timeout_ms is not None:
            args["timeoutMs"] = timeout_ms
        return await self._b.call("http.request", args)

    async def get(
        self, url: str, headers: Mapping[str, str] | None = None, timeout_ms: int | None = None
    ) -> HttpResponse:
        return await self.request("GET", url, headers=headers, timeout_ms=timeout_ms)

    async def post(
        self,
        url: str,
        body: str | None = None,
        headers: Mapping[str, str] | None = None,
        timeout_ms: int | None = None,
    ) -> HttpResponse:
        return await self.request("POST", url, headers=headers, body=body, timeout_ms=timeout_ms)


class _Log:
    def __init__(self, bridge: Bridge) -> None:
        self._b = bridge

    async def info(self, message: str, **fields: object) -> None:
        return await self._b.call("log.info", {"message": message, "fields": fields})


class Ctx:
    """The host context passed to `async def run(inputs, ctx)`."""

    def __init__(self, bridge: Bridge, run: RunInfo) -> None:
        self._b = bridge
        self._run: RunInfo = {"id": run["id"], "key": run["key"]}
        self.secrets = _Secrets(bridge)
        self.memory = _Memory(bridge)
        self.files = _Files(bridge)
        self.http = _Http(bridge)
        self.log = _Log(bridge)

    def run(self) -> RunInfo:
        """This run's id and the invocation's logical key.

        A retry of the same invocation carries the same key, so a skill sends
        `key` as `Idempotency-Key` on an external write and a destination that
        honours it acts once.
        """
        return {"id": self._run["id"], "key": self._run["key"]}

    async def now(self) -> str:
        return await self._b.call("now", {})

    async def user(self) -> User:
        return await self._b.call("user", {})
