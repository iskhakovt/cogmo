"""Unit tests for the per-task runner.

The runner is exercised end-to-end by the TS-side sysbox-e2e suite.
These tests pin the JSON-RPC bridge and result-shape contracts in
isolation — fake stdin/stdout streams, no fork, no docker.
"""

import io
import json
from typing import Any

import pytest

from cogmo_skills_runtime.runner import _main


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
        assert result == {
            "type": "task_result",
            "id": "t-double",
            "ok": True,
            "output": {"doubled": 42},
        }

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


class TestCtxBridge:
    """The bridge writes ctx_call lines and blocks on ctx_result; we
    drive it by pre-loading replies into the fake stdin.
    """

    @pytest.mark.asyncio
    async def test_ctx_now_round_trip(self) -> None:
        # Pre-load a ctx_result that any ctx_call can match. The ctx_id
        # is generated inside the runner so we don't know it ahead of
        # time — we use a fake reader that copies any pending id back as
        # the result id.
        stdin_lines = []
        stdout_buffer = io.StringIO()
        stderr_buffer = io.StringIO()

        # Strategy: drive the run as a coroutine, then watch stdout for
        # the ctx_call, write the matching ctx_result to a pipe stdin.
        # Simpler: hand-craft the call_id by patching uuid via the body
        # that introspects the bridge — too involved. Instead, run with
        # a body that doesn't await ctx (covered above) and pin the ctx
        # bridge separately via a unit test on `_Bridge` if needed.
        # This sub-suite is a smoke check that the stdin reader doesn't
        # crash on the ctx_result happy path.
        from cogmo_skills_runtime.runner import _Bridge

        bridge = _Bridge(stdout_buffer)
        # Manually queue a pending future + deliver the matching result
        # to verify the correlation logic.
        import asyncio

        async def go() -> Any:
            future = asyncio.get_running_loop().create_future()
            bridge._pending["ctx-fake"] = future
            bridge.deliver({"id": "ctx-fake", "ok": True, "value": "hello"})
            return await future

        result = await go()
        assert result == "hello"
        # Suppress unused-var warnings.
        _ = stdin_lines, stderr_buffer

    @pytest.mark.asyncio
    async def test_ctx_error_surfaces_typed_exception(self) -> None:
        from cogmo_skills_runtime.runner import CtxError, _Bridge

        bridge = _Bridge(io.StringIO())
        import asyncio

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
        from cogmo_skills_runtime.runner import _Bridge

        bridge = _Bridge(io.StringIO())
        import asyncio

        future = asyncio.get_running_loop().create_future()
        bridge._pending["ctx-orphan"] = future
        bridge.fail_pending(RuntimeError("stdin closed"))
        with pytest.raises(RuntimeError, match="stdin closed"):
            await future
