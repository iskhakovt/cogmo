"""Unit tests for the per-task runner.

The runner is exercised end-to-end by the TS-side sysbox-e2e suite.
These tests pin the JSON-RPC bridge and result-shape contracts in
isolation — fake stdin/stdout streams, no fork, no docker.
"""

import asyncio
import io
import json
from typing import Any

import pytest

from cogmo_skills_runtime.runner import CtxError, _Bridge, _main


async def _drive(
    body: str,
    inputs: Any,
    task_id: str,
    *,
    stdin_text: str = "",
) -> dict[str, Any]:
    """Run `_main` with fake streams, return the parsed task_result."""
    stdin = io.BytesIO(stdin_text.encode("utf-8"))
    stdout = io.StringIO()
    stderr = io.StringIO()
    await _main(body, inputs, task_id, stdin=stdin, stdout=stdout, stderr=stderr)
    out = stdout.getvalue().strip().splitlines()
    # Last line is the task_result; earlier lines are ctx_calls (none in
    # these tests since we don't await ctx).
    assert out, f"no output written; stderr was: {stderr.getvalue()!r}"
    parsed = json.loads(out[-1])
    assert parsed["type"] == "task_result"
    return parsed


class TestHappyPath:
    @pytest.mark.asyncio
    async def test_returns_simple_result(self) -> None:
        result = await _drive(
            body=("async def run(inputs, ctx):\n    return {'doubled': inputs['x'] * 2}\n"),
            inputs={"x": 21},
            task_id="t-double",
        )
        # Subset assertion — `rusage` is also present on every result; its
        # shape is covered separately in TestRusage.
        assert result["type"] == "task_result"
        assert result["id"] == "t-double"
        assert result["ok"] is True
        assert result["output"] == {"doubled": 42}

    @pytest.mark.asyncio
    async def test_returns_none_output(self) -> None:
        result = await _drive(
            body="async def run(inputs, ctx):\n    return None\n",
            inputs={},
            task_id="t-none",
        )
        assert result["ok"] is True
        assert result["output"] is None

    @pytest.mark.asyncio
    async def test_unicode_round_trip(self) -> None:
        result = await _drive(
            body="async def run(inputs, ctx):\n    return {'msg': inputs['msg']}\n",
            inputs={"msg": "héllo 🌍 ✨"},
            task_id="t-unicode",
        )
        assert result["output"] == {"msg": "héllo 🌍 ✨"}


class TestErrors:
    @pytest.mark.asyncio
    async def test_syntax_error(self) -> None:
        result = await _drive(
            body="def bad(:\n",  # unbalanced paren — fails at compile time
            inputs={},
            task_id="t-syntax",
        )
        assert result["ok"] is False
        assert "SyntaxError" in result["error"]

    @pytest.mark.asyncio
    async def test_skill_raises(self) -> None:
        result = await _drive(
            body=("async def run(inputs, ctx):\n    raise RuntimeError('skill failed')\n"),
            inputs={},
            task_id="t-raise",
        )
        assert result["ok"] is False
        assert "RuntimeError" in result["error"]
        assert "skill failed" in result["error"]
        assert "traceback" in result

    @pytest.mark.asyncio
    async def test_missing_run_function(self) -> None:
        result = await _drive(
            body="x = 1\n",
            inputs={},
            task_id="t-no-run",
        )
        assert result["ok"] is False
        assert "async def run" in result["error"]

    @pytest.mark.asyncio
    async def test_sync_run_function_rejected(self) -> None:
        result = await _drive(
            body="def run(inputs, ctx):\n    return None\n",
            inputs={},
            task_id="t-sync",
        )
        assert result["ok"] is False
        assert "async def run" in result["error"]


class TestRusage:
    """`rusage.peakMemoryBytes` lands on every task_result the runner emits.

    The host reads it back into `skill_runs.resource_usage.peakMemoryBytes`.
    Linux `ru_maxrss` is in kilobytes; the runner multiplies by 1024 so
    the host sees bytes. The Python tests don't pin the exact value
    (varies with the test runner's RSS) — only the shape: a positive int.
    """

    @pytest.mark.asyncio
    async def test_rusage_on_ok_result(self) -> None:
        result = await _drive(
            body="async def run(inputs, ctx):\n    return inputs\n",
            inputs={"ok": True},
            task_id="t-rusage-ok",
        )
        assert result["ok"] is True
        assert "rusage" in result
        assert isinstance(result["rusage"]["peakMemoryBytes"], int)
        assert result["rusage"]["peakMemoryBytes"] > 0

    @pytest.mark.asyncio
    async def test_rusage_on_error_result(self) -> None:
        result = await _drive(
            body="async def run(inputs, ctx):\n    raise ValueError('boom')\n",
            inputs={},
            task_id="t-rusage-err",
        )
        assert result["ok"] is False
        assert "rusage" in result
        assert isinstance(result["rusage"]["peakMemoryBytes"], int)
        assert result["rusage"]["peakMemoryBytes"] > 0


class TestCtxBridge:
    """Direct unit tests on `_Bridge` — the call/deliver/fail correlation
    logic is exercised end-to-end via the supervisor in sysbox-e2e, but
    these isolate the request-id matching contract.
    """

    @pytest.mark.asyncio
    async def test_deliver_resolves_pending_future(self) -> None:
        bridge = _Bridge(io.StringIO())
        future = asyncio.get_running_loop().create_future()
        bridge._pending["ctx-fake"] = future
        bridge.deliver({"id": "ctx-fake", "ok": True, "value": "hello"})
        assert await future == "hello"

    @pytest.mark.asyncio
    async def test_deliver_surfaces_typed_ctx_error(self) -> None:
        bridge = _Bridge(io.StringIO())
        future = asyncio.get_running_loop().create_future()
        bridge._pending["ctx-err"] = future
        bridge.deliver(
            {
                "id": "ctx-err",
                "ok": False,
                "errorKind": "permission_denied",
                "message": "no read access",
            }
        )
        with pytest.raises(CtxError) as excinfo:
            await future
        assert excinfo.value.kind == "permission_denied"
        assert "no read access" in excinfo.value.message

    @pytest.mark.asyncio
    async def test_fail_pending_rejects_outstanding_calls(self) -> None:
        bridge = _Bridge(io.StringIO())
        future = asyncio.get_running_loop().create_future()
        bridge._pending["ctx-orphan"] = future
        bridge.fail_pending(RuntimeError("stdin closed"))
        with pytest.raises(RuntimeError, match="stdin closed"):
            await future
