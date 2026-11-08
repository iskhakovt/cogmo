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
async def test_keys_pydantic_writes_alike_or_cannot_write_are_output_invalid() -> None:
    class Keyed(BaseModel):
        counts: dict[Any, int]

    def returning(counts: object):
        async def run(inputs: object, ctx: Ctx) -> object:
            return {"counts": counts}

        return run

    assert (await call_run({"Output": Keyed}, returning({b"x": 1, "x": 2}), {}, CTX))[0] == (
        "output_invalid",
        "two keys of one dict are written alike as JSON strings, so one would be lost",
    )
    assert (await call_run({"Output": Keyed}, returning({frozenset([1]): 1}), {}, CTX))[0] == (
        "output_invalid",
        "Error serializing to JSON: TypeError: `frozenset` not valid as object key",
    )
    assert await call_run({"Output": Keyed}, returning({b"x": 1}), {}, CTX) == (None, {"counts": {"x": 1}})


@pytest.mark.asyncio
async def test_a_model_s_own_json_serialization_stands() -> None:
    from pydantic import ConfigDict

    class Encoded(BaseModel):
        model_config = ConfigDict(ser_json_bytes="base64")
        raw: bytes

    async def run(inputs: object, ctx: Ctx) -> object:
        return {"raw": b"\xff"}

    assert await call_run({"Output": Encoded}, run, {}, CTX) == (None, {"raw": "_w=="})


@pytest.mark.asyncio
async def test_a_model_that_writes_nan_and_bytes_keys_its_own_way_is_not_refused() -> None:
    from pydantic import ConfigDict

    class Faithful(BaseModel):
        model_config = ConfigDict(ser_json_inf_nan="strings", ser_json_bytes="base64")
        ratio: float
        by_key: dict[bytes, int]

    async def run(inputs: object, ctx: Ctx) -> object:
        return {"ratio": float("nan"), "by_key": {b"\xff": 1}}

    assert await call_run({"Output": Faithful}, run, {}, CTX) == (None, {"ratio": "NaN", "by_key": {"_w==": 1}})


@pytest.mark.asyncio
async def test_a_non_finite_number_inside_a_list_or_set_is_output_invalid() -> None:
    class Collections(BaseModel):
        listed: list[float]
        unique: set[float]

    async def in_list(inputs: object, ctx: Ctx) -> object:
        return {"listed": [1.0, float("inf")], "unique": set()}

    async def in_set(inputs: object, ctx: Ctx) -> object:
        return {"listed": [], "unique": {1.0, float("nan")}}

    assert (await call_run({"Output": Collections}, in_list, {}, CTX))[0] == (
        "output_invalid",
        "inf is not a finite number, which JSON writes as null",
    )
    assert (await call_run({"Output": Collections}, in_set, {}, CTX))[0] == (
        "output_invalid",
        "a set holds a number that is not finite, which JSON writes as null",
    )


@pytest.mark.asyncio
async def test_a_set_is_refused_for_a_null_its_json_adds_and_no_other() -> None:
    from pydantic import ConfigDict

    class Pairs(BaseModel):
        points: set[tuple[float, float]]

    class Kept(BaseModel):
        model_config = ConfigDict(ser_json_inf_nan="strings")
        values: set[float | None]

    async def nested(inputs: object, ctx: Ctx) -> object:
        return {"points": {(1.0, float("nan"))}}

    async def genuine_none(inputs: object, ctx: Ctx) -> object:
        return {"values": {None, float("nan")}}

    assert (await call_run({"Output": Pairs}, nested, {}, CTX))[0] == (
        "output_invalid",
        "a set holds a number that is not finite, which JSON writes as null",
    )
    failure, output = await call_run({"Output": Kept}, genuine_none, {}, CTX)
    assert failure is None
    assert isinstance(output, dict) and sorted(output["values"], key=str) == ["NaN", None]


@pytest.mark.asyncio
async def test_a_json_only_serializer_that_writes_more_keys_is_not_refused() -> None:
    from pydantic import model_serializer

    class Annotated(BaseModel):
        n: int

        @model_serializer(mode="wrap")
        def with_kind(self, handler: Any, info: Any) -> dict[str, object]:
            data = handler(self)
            return {**data, "kind": "annotated"} if info.mode == "json" else data

    async def run(inputs: object, ctx: Ctx) -> object:
        return {"n": 1}

    assert await call_run({"Output": Annotated}, run, {}, CTX) == (None, {"n": 1, "kind": "annotated"})


@pytest.mark.asyncio
async def test_a_type_error_an_output_validator_raises_propagates() -> None:
    from pydantic import field_validator

    class Checked(BaseModel):
        n: int

        @field_validator("n")
        @classmethod
        def broken(cls, n: int) -> int:
            raise TypeError("a bug in the validator")

    async def run(inputs: object, ctx: Ctx) -> object:
        return {"n": 1}

    with pytest.raises(TypeError, match="a bug in the validator"):
        await call_run({"Output": Checked}, run, {}, CTX)


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
