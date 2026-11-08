"""`cogmo_ctx._run.call_run`: a skill's `run` under its `Input` and `Output` models, and a `SkillError` as a value."""

from collections.abc import Mapping
from datetime import UTC, datetime
from typing import Any

import pytest
from pydantic import BaseModel

from cogmo_ctx import Ctx, SkillError
from cogmo_ctx._run import call_run


class _NoBridge:
    async def call(self, method: str, args: Mapping[str, object]) -> Any:
        raise AssertionError("no ctx call expected")


CTX = Ctx(_NoBridge(), {"id": "run-1", "key": "key-1"})


class Input(BaseModel):
    n: int = 1


class Output(BaseModel):
    doubled: int
    at: datetime


async def _echo(inputs: object, ctx: Ctx) -> object:
    return inputs


@pytest.mark.asyncio
async def test_a_skill_with_no_models_gets_its_inputs_and_returns_its_output_unchanged() -> None:
    assert await call_run({"run": _echo}, _echo, {"x": 1}, CTX) == (None, {"x": 1})


@pytest.mark.asyncio
async def test_input_applies_defaults_and_coercion_before_run() -> None:
    seen: list[object] = []

    async def run(inputs: object, ctx: Ctx) -> object:
        seen.append(inputs)
        return None

    await call_run({"Input": Input}, run, {}, CTX)
    await call_run({"Input": Input}, run, {"n": "3"}, CTX)
    assert seen == [Input(n=1), Input(n=3)]


@pytest.mark.asyncio
async def test_inputs_input_refuses_are_input_invalid_and_run_never_runs() -> None:
    ran: list[bool] = []

    async def run(inputs: object, ctx: Ctx) -> object:
        ran.append(True)
        return None

    failure, output = await call_run({"Input": Input}, run, {"n": "many"}, CTX)
    assert failure == ("input_invalid", "n: Input should be a valid integer, unable to parse string as an integer")
    assert (output, ran) == (None, [])


@pytest.mark.asyncio
async def test_output_is_validated_and_dumped_as_json() -> None:
    at = datetime(2026, 11, 8, 12, 0, tzinfo=UTC)

    async def returns_dict(inputs: object, ctx: Ctx) -> object:
        return {"doubled": "4", "at": at}

    async def returns_model(inputs: object, ctx: Ctx) -> object:
        return Output(doubled=4, at=at)

    expected = (None, {"doubled": 4, "at": "2026-11-08T12:00:00Z"})
    assert await call_run({"Output": Output}, returns_dict, {}, CTX) == expected
    assert await call_run({"Output": Output}, returns_model, {}, CTX) == expected


@pytest.mark.asyncio
async def test_an_output_output_refuses_is_output_invalid_and_keeps_what_run_returned() -> None:
    async def run(inputs: object, ctx: Ctx) -> object:
        return {"doubled": 4}

    assert await call_run({"Output": Output}, run, {}, CTX) == (
        ("output_invalid", "at: Field required"),
        {"doubled": 4},
    )


@pytest.mark.asyncio
async def test_bytes_json_mode_cannot_decode_are_output_invalid() -> None:
    class Raw(BaseModel):
        raw: bytes

    async def run(inputs: object, ctx: Ctx) -> object:
        return {"raw": b"\xff"}

    failure, kept = await call_run({"Output": Raw}, run, {}, CTX)
    assert failure is not None and failure[0] == "output_invalid"
    assert kept == {"raw": b"\xff"}


@pytest.mark.asyncio
async def test_an_output_json_mode_would_change_is_output_invalid() -> None:
    class Measured(BaseModel):
        ratio: float
        counts: dict[Any, int]

    async def nan(inputs: object, ctx: Ctx) -> object:
        return {"ratio": float("nan"), "counts": {}}

    async def colliding(inputs: object, ctx: Ctx) -> object:
        return {"ratio": 1.0, "counts": {1: 1, "1": 2}}

    assert (await call_run({"Output": Measured}, nan, {}, CTX))[0] == (
        "output_invalid",
        "nan is not a finite number, which JSON writes as null",
    )
    assert (await call_run({"Output": Measured}, colliding, {}, CTX))[0] == (
        "output_invalid",
        "two keys of one dict are written alike as JSON strings, so one would be lost",
    )


@pytest.mark.asyncio
async def test_a_refusal_names_twenty_fields_and_counts_the_rest() -> None:
    class Many(BaseModel):
        items: list[int]

    async def run(inputs: object, ctx: Ctx) -> object:
        return {"items": ["x"] * 25}

    failure, _kept = await call_run({"Output": Many}, run, {}, CTX)
    assert failure is not None
    assert failure[1].count("items.") == 20
    assert failure[1].endswith("; and 5 more")


@pytest.mark.asyncio
async def test_a_value_json_mode_cannot_serialize_is_output_invalid() -> None:
    class Opaque(BaseModel):
        value: Any

    async def run(inputs: object, ctx: Ctx) -> object:
        return {"value": object()}

    failure, _kept = await call_run({"Output": Opaque}, run, {}, CTX)
    assert failure is not None and failure[0] == "output_invalid"
    assert "Unable to serialize unknown type" in failure[1]


@pytest.mark.asyncio
async def test_a_skill_error_a_validator_raises_is_its_kind() -> None:
    from pydantic import field_validator

    class Strict(BaseModel):
        n: int

        @field_validator("n")
        @classmethod
        def positive(cls, n: int) -> int:
            if n < 0:
                raise SkillError("negative", "n must be positive")
            return n

    assert await call_run({"Input": Strict}, _echo, {"n": -1}, CTX) == (
        ("skill_failed", "negative: n must be positive"),
        None,
    )


@pytest.mark.asyncio
@pytest.mark.parametrize(("retryable", "kind"), [(False, "skill_failed"), (True, "skill_retryable")])
async def test_a_skill_error_is_its_kind(retryable: bool, kind: str) -> None:
    async def run(inputs: object, ctx: Ctx) -> object:
        raise SkillError("not_found", "no such feed", retryable=retryable)

    assert await call_run({}, run, {}, CTX) == ((kind, "not_found: no such feed"), None)


@pytest.mark.asyncio
async def test_a_name_that_is_not_a_pydantic_model_is_no_contract() -> None:
    class Plain:
        pass

    assert await call_run({"Input": Plain, "Output": dict}, _echo, {"x": 1}, CTX) == (None, {"x": 1})


@pytest.mark.asyncio
async def test_anything_else_run_raises_propagates() -> None:
    async def run(inputs: object, ctx: Ctx) -> object:
        raise ValueError("boom")

    with pytest.raises(ValueError, match="boom"):
        await call_run({}, run, {}, CTX)
