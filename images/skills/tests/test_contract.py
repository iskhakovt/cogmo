"""The Python side's frames against the worker protocol's schemas (`conftest.protocol`).

Every ctx method's arguments as `cogmo_ctx` sends them, and every `task_result`
the runner writes. The supervisor's own frames are checked in
`test_task_isolation.py`, where a real supervisor sends them.
"""

import io
import json
from collections.abc import Awaitable, Callable, Mapping
from typing import Any

import pytest

from cogmo_ctx import Ctx
from cogmo_skills_runtime.runner import _main

RUN = {"id": "run-1", "key": "key-1"}

# The `protocol` fixture (conftest.py).
type ProtocolCheck = Callable[[str, object], None]


class _RecordingBridge:
    def __init__(self) -> None:
        self.calls: list[tuple[str, dict[str, object]]] = []

    async def call(self, method: str, args: Mapping[str, object]) -> Any:
        self.calls.append((method, dict(args)))
        return {"entries": []} if method == "files.list" else None


CALLS: list[Callable[[Ctx], Awaitable[object]]] = [
    lambda c: c.secrets.get("token"),
    lambda c: c.memory.recall("q"),
    lambda c: c.memory.recall("q", limit=3),
    lambda c: c.memory.remember("fact"),
    lambda c: c.memory.remember("fact", tags=["a"]),
    lambda c: c.files.read("a.txt"),
    lambda c: c.files.write("a.txt", "x"),
    lambda c: c.files.list(),
    lambda c: c.files.list(prefix="a"),
    lambda c: c.now(),
    lambda c: c.user(),
    lambda c: c.log.info("hi", n=1),
    lambda c: c.http.get("https://x.test/a", headers={"h": "v"}, timeout_ms=5),
    lambda c: c.http.post("https://x.test/a", body="b"),
    lambda c: c.http.request("delete", "https://x.test/a"),
]


@pytest.mark.asyncio
async def test_every_ctx_call_matches_its_method_s_argument_schema(
    protocol: ProtocolCheck, contract_definitions: dict[str, object]
) -> None:
    bridge = _RecordingBridge()
    ctx = Ctx(bridge, RUN)
    for call in CALLS:
        await call(ctx)
    for method, args in bridge.calls:
        protocol(f"ctx.{method}.args", args)
    methods = {
        name.removeprefix("ctx.").removesuffix(".args") for name in contract_definitions if name.endswith(".args")
    }
    assert {method for method, _ in bridge.calls} == methods


async def _task_result(body: str) -> dict[str, Any]:
    stdout = io.StringIO()
    await _main(body, {}, "t-contract", RUN, stdin=io.BytesIO(b""), stdout=stdout, stderr=io.StringIO())
    return json.loads(stdout.getvalue().splitlines()[-1])


@pytest.mark.asyncio
@pytest.mark.parametrize(
    "body",
    [
        "async def run(inputs, ctx):\n    return {'n': 1}\n",
        "async def run(inputs, ctx):\n    raise ValueError('boom')\n",
        "from cogmo_ctx import SkillError\nasync def run(inputs, ctx):\n    raise SkillError('k', 'm')\n",
        "async def run(inputs, ctx):\n    return {1, 2}\n",
        "def run(inputs, ctx):\n    return 1\n",
        "def broken(:\n",
        "async def run(inputs, ctx):\n    raise MemoryError()\n",
    ],
)
async def test_every_task_result_the_runner_writes_matches_the_schema(protocol: ProtocolCheck, body: str) -> None:
    protocol("task_result", await _task_result(body))
