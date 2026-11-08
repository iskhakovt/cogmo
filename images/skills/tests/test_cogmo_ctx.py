"""`cogmo_ctx` over a recording bridge: the call each method sends, what it returns, and `ctx.run()`."""

from collections.abc import Awaitable, Callable, Mapping
from typing import Any

import pytest

from cogmo_ctx import Ctx, CtxError, RunInfo, SkillError

RUN: RunInfo = {"id": "run-1", "key": "skill-tool:call-1"}


class _RecordingBridge:
    def __init__(self, reply: Any = None) -> None:
        self.calls: list[tuple[str, dict[str, object]]] = []
        self._reply = reply

    async def call(self, method: str, args: Mapping[str, object]) -> Any:
        self.calls.append((method, dict(args)))
        return self._reply


@pytest.mark.asyncio
@pytest.mark.parametrize(
    ("invoke", "method", "args"),
    [
        (lambda c: c.secrets.get("token"), "secrets.get", {"name": "token"}),
        (lambda c: c.memory.recall("q"), "memory.recall", {"query": "q"}),
        (lambda c: c.memory.recall("q", limit=3), "memory.recall", {"query": "q", "limit": 3}),
        (lambda c: c.memory.remember("fact"), "memory.remember", {"content": "fact"}),
        (lambda c: c.memory.remember("fact", tags=("a",)), "memory.remember", {"content": "fact", "tags": ["a"]}),
        (lambda c: c.files.read("a.txt"), "files.read", {"path": "a.txt"}),
        (lambda c: c.files.write("a.txt", "x"), "files.write", {"path": "a.txt", "content": "x"}),
        (lambda c: c.http.request("get", "https://x.test"), "http.request", {"method": "GET", "url": "https://x.test"}),
        (
            lambda c: c.http.post("https://x.test", body="b", headers={"h": "v"}, timeout_ms=5),
            "http.request",
            {"method": "POST", "url": "https://x.test", "headers": {"h": "v"}, "body": "b", "timeoutMs": 5},
        ),
        (lambda c: c.http.get("https://x.test"), "http.request", {"method": "GET", "url": "https://x.test"}),
        (lambda c: c.log.info("hi", n=1), "log.info", {"message": "hi", "fields": {"n": 1}}),
        (lambda c: c.now(), "now", {}),
        (lambda c: c.user(), "user", {}),
    ],
)
async def test_each_method_sends_its_call(
    invoke: Callable[[Ctx], Awaitable[object]], method: str, args: dict[str, object]
) -> None:
    bridge = _RecordingBridge(reply="value")
    assert await invoke(Ctx(bridge, RUN)) == "value"
    assert bridge.calls == [(method, args)]


@pytest.mark.asyncio
async def test_files_list_returns_the_entries() -> None:
    bridge = _RecordingBridge(reply={"entries": [{"path": "a.txt"}]})
    assert await Ctx(bridge, RUN).files.list(prefix="a") == [{"path": "a.txt"}]
    assert bridge.calls == [("files.list", {"prefix": "a"})]


@pytest.mark.asyncio
async def test_a_refusal_reaches_the_skill_as_ctx_error() -> None:
    class _Refusing:
        async def call(self, method: str, args: Mapping[str, object]) -> Any:
            raise CtxError("blocked_destination", "x.test is not allowed")

    with pytest.raises(CtxError) as excinfo:
        await Ctx(_Refusing(), RUN).http.get("https://x.test")
    assert (excinfo.value.kind, excinfo.value.message) == ("blocked_destination", "x.test is not allowed")


def test_run_returns_the_run_and_a_copy_each_time() -> None:
    given: RunInfo = {"id": "run-1", "key": "k"}
    ctx = Ctx(_RecordingBridge(), given)
    given["key"] = "changed"
    first = ctx.run()
    first["key"] = "mutated"
    assert ctx.run() == {"id": "run-1", "key": "k"}


def test_skill_error_carries_its_kind_message_and_retryable() -> None:
    plain = SkillError("not_found", "no such feed")
    retryable = SkillError("upstream_down", "503", retryable=True)
    assert (plain.kind, plain.message, plain.retryable, str(plain)) == (
        "not_found",
        "no such feed",
        False,
        "not_found: no such feed",
    )
    assert retryable.retryable is True
