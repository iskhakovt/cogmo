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

from cogmo_skills_runtime import runner
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
        assert result["errorKind"] == "load_failed"
        assert "SyntaxError" in result["error"]

    @pytest.mark.asyncio
    async def test_skill_raises(self) -> None:
        result = await _drive(
            body=("async def run(inputs, ctx):\n    raise RuntimeError('skill failed')\n"),
            inputs={},
            task_id="t-raise",
        )
        assert result["ok"] is False
        assert result["errorKind"] == "skill_raised"
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
        assert result["errorKind"] == "load_failed"
        assert "async def run" in result["error"]

    @pytest.mark.asyncio
    async def test_sync_run_function_rejected(self) -> None:
        result = await _drive(
            body="def run(inputs, ctx):\n    return None\n",
            inputs={},
            task_id="t-sync",
        )
        assert result["ok"] is False
        assert result["errorKind"] == "load_failed"
        assert "async def run" in result["error"]

    @pytest.mark.asyncio
    async def test_body_raising_at_import_fails_to_load(self) -> None:
        result = await _drive(
            body="import not_a_module\n\nasync def run(inputs, ctx):\n    return None\n",
            inputs={},
            task_id="t-import",
        )
        assert result["ok"] is False
        assert result["errorKind"] == "load_failed"
        assert "ModuleNotFoundError" in result["error"]

    @pytest.mark.asyncio
    async def test_memory_error_is_memory_exceeded(self) -> None:
        result = await _drive(
            body="async def run(inputs, ctx):\n    raise MemoryError()\n",
            inputs={},
            task_id="t-oom",
        )
        assert result["ok"] is False
        assert result["errorKind"] == "memory_exceeded"

    @pytest.mark.asyncio
    async def test_uncaught_ctx_error_is_skill_raised(self) -> None:
        result = await _drive(
            body=(
                "from cogmo_skills_runtime.runner import CtxError\n"
                "async def run(inputs, ctx):\n    raise CtxError('missing_effect', 'needs reads_memory')\n"
            ),
            inputs={},
            task_id="t-ctx",
        )
        assert result["ok"] is False
        assert result["errorKind"] == "skill_raised"
        assert result["error"] == "missing_effect: needs reads_memory"

    @pytest.mark.asyncio
    @pytest.mark.parametrize(
        ("value", "message"),
        [
            ("float('nan')", "Out of range float values are not JSON compliant"),
            ("float('inf')", "Out of range float values are not JSON compliant"),
            ("{1, 2}", "Object of type set is not JSON serializable"),
        ],
    )
    async def test_output_json_cannot_carry_is_output_invalid(self, value: str, message: str) -> None:
        result = await _drive(
            body=f"async def run(inputs, ctx):\n    return {{'v': {value}}}\n",
            inputs={},
            task_id="t-nonjson",
        )
        assert result["ok"] is False
        assert result["errorKind"] == "output_invalid"
        assert message in result["error"]

    @pytest.mark.asyncio
    async def test_integer_the_host_would_round_is_output_invalid(self) -> None:
        result = await _drive(
            body="async def run(inputs, ctx):\n    return {'id': 2**53, 'ok': 2**53 - 1}\n",
            inputs={},
            task_id="t-bigint",
        )
        assert result["ok"] is False
        assert result["errorKind"] == "output_invalid"
        assert "integer 9007199254740992 is past 2**53" in result["error"]

    @pytest.mark.asyncio
    async def test_keys_json_writes_alike_are_output_invalid(self) -> None:
        result = await _drive(
            body="async def run(inputs, ctx):\n    return {1: 'a', '1': 'b'}\n",
            inputs={},
            task_id="t-keys",
        )
        assert result["ok"] is False
        assert result["errorKind"] == "output_invalid"
        assert "two keys of one dict are written alike" in result["error"]

    @pytest.mark.asyncio
    async def test_memory_error_while_encoding_is_memory_exceeded(self, monkeypatch: pytest.MonkeyPatch) -> None:
        def exhausted(output: object) -> str:
            raise MemoryError()

        monkeypatch.setattr(runner, "_encode_output", exhausted)
        result = await _drive(
            body="async def run(inputs, ctx):\n    return {'big': True}\n",
            inputs={},
            task_id="t-oom-encode",
        )
        assert result["ok"] is False
        assert result["errorKind"] == "memory_exceeded"

    @pytest.mark.asyncio
    async def test_memory_error_at_import_is_memory_exceeded(self) -> None:
        result = await _drive(
            body="raise MemoryError()\nasync def run(inputs, ctx):\n    return None\n",
            inputs={},
            task_id="t-oom-import",
        )
        assert result["ok"] is False
        assert result["errorKind"] == "memory_exceeded"

    @pytest.mark.asyncio
    async def test_output_past_the_frame_cap_is_output_invalid(self) -> None:
        result = await _drive(
            body="async def run(inputs, ctx):\n    return 'x' * (17 * 1024 * 1024)\n",
            inputs={},
            task_id="t-huge",
        )
        assert result["ok"] is False
        assert result["errorKind"] == "output_invalid"
        assert "the cap is" in result["error"]

    @pytest.mark.asyncio
    async def test_output_is_carried_as_json_carries_it(self) -> None:
        result = await _drive(
            body="async def run(inputs, ctx):\n    return {'t': (1, 2), 3: 'int key'}\n",
            inputs={},
            task_id="t-json",
        )
        assert result["ok"] is True
        assert result["output"] == {"t": [1, 2], "3": "int key"}


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


class TestAfterResult:
    @pytest.mark.asyncio
    async def test_ctx_refuses_calls_once_the_result_is_out(self) -> None:
        body = (
            "import asyncio\n"
            "async def _late(ctx, seen):\n"
            "    await asyncio.sleep(0.01)\n"
            "    try:\n"
            "        await ctx.now()\n"
            "    except Exception as e:\n"
            "        seen.append(getattr(e, 'kind', type(e).__name__))\n"
            "async def run(inputs, ctx):\n"
            "    asyncio.get_running_loop().create_task(_late(ctx, inputs['seen']))\n"
            "    return 'done'\n"
        )
        seen: list[str] = []
        stdout = io.StringIO()
        await _main(body, {"seen": seen}, "t-after", stdin=io.BytesIO(b""), stdout=stdout, stderr=io.StringIO())
        await asyncio.sleep(0.05)

        frames = [json.loads(line) for line in stdout.getvalue().splitlines()]
        assert [f["type"] for f in frames] == ["task_result"]
        assert seen == ["task_finished"]
