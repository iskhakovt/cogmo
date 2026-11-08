"""How both tiers call a skill's `run`: under its `Input` and `Output` models, with a `SkillError` as a value.

The container runner and the wasm worker share this file, so a skill's contract holds the same on both
tiers (design/skills.md → Contracts).
"""

import json
import math
import sys
from collections.abc import Awaitable, Callable, Mapping
from typing import Any, Literal

from cogmo_ctx import Ctx, SkillError

type RunFailure = tuple[Literal["input_invalid", "output_invalid", "skill_failed", "skill_retryable"], str]
"""A failure the run reports as a value: its run error kind and its message."""


def _model(namespace: Mapping[str, object], name: str) -> Any | None:
    """The skill's pydantic model called `name`, or None.

    A skill that never imported pydantic defines no model, and the check leaves pydantic unimported.
    """
    pydantic = sys.modules.get("pydantic")
    candidate = namespace.get(name)
    if pydantic is None or not isinstance(candidate, type) or not issubclass(candidate, pydantic.BaseModel):
        return None
    return candidate


# How many refused fields a validation message names before it counts the rest.
_MAX_DESCRIBED = 20


def _describe(error: Exception) -> str:
    """A validation error as one `loc: msg` segment per refused field, joined by `; `.

    It names the first 20 fields and ends `and N more` past them.
    """
    errors = getattr(error, "errors", None)
    if not callable(errors):
        return str(error)
    items = errors(include_url=False)
    segments = [
        f"{'.'.join(str(part) for part in item['loc']) or '<root>'}: {item['msg']}" for item in items[:_MAX_DESCRIBED]
    ]
    if len(items) > _MAX_DESCRIBED:
        segments.append(f"and {len(items) - _MAX_DESCRIBED} more")
    return "; ".join(segments)


def _lossy(python: object, dumped: object) -> str | None:
    """What the model's JSON changed of its Python dump, or None.

    Walked side by side, so the model's own serialization settings stand: a dict that lost keys (two keys
    JSON writes alike, `1` and `"1"`), or a non-finite float written as `null`. Both would reach the host
    changed.
    """
    pending: list[tuple[object, object]] = [(python, dumped)]
    while pending:
        before, after = pending.pop()
        if isinstance(before, float) and not math.isfinite(before) and after is None:
            return f"{before} is not a finite number, which JSON writes as null"
        if isinstance(before, dict) and isinstance(after, dict):
            if len(after) < len(before):
                return "two keys of one dict are written alike as JSON strings, so one would be lost"
            pending.extend(zip(before.values(), after.values(), strict=True))
        elif isinstance(before, list | tuple) and isinstance(after, list) and len(before) == len(after):
            pending.extend(zip(before, after, strict=True))
    return None


async def call_run(
    namespace: Mapping[str, object],
    run: Callable[[Any, Ctx], Awaitable[object]],
    inputs: object,
    ctx: Ctx,
) -> tuple[RunFailure | None, object]:
    """Call `run` under the skill's contract: `(None, output)`, or `(failure, kept)`.

    With an `Input` model, `run` receives `Input.model_validate(inputs)`, so pydantic applies defaults and
    coercion; a refusal is `input_invalid`. With an `Output` model, the output is
    `Output.model_validate(result)` written as the model's own JSON; a refusal is `output_invalid`, and `kept` is what
    `run` returned, which the worker keeps when JSON carries it. A `SkillError` is `skill_failed`, or
    `skill_retryable` with `retryable=True`, raised by `run` or by a model's validator. `kept` is None but for
    `output_invalid`. Anything else propagates.
    """
    try:
        input_model = _model(namespace, "Input")
        if input_model is not None:
            from pydantic import ValidationError

            try:
                inputs = input_model.model_validate(inputs)
            except ValidationError as e:
                return ("input_invalid", _describe(e)), None
        output = await run(inputs, ctx)
        output_model = _model(namespace, "Output")
        if output_model is not None:
            from pydantic import ValidationError

            try:
                validated = output_model.model_validate(output)
            except ValidationError as e:
                return ("output_invalid", _describe(e)), output
            try:
                # The model's own JSON, read back: its serialization settings (`ser_json_inf_nan`,
                # `ser_json_bytes`) decide what the host receives.
                dumped = json.loads(validated.model_dump_json())
                lossy = _lossy(validated.model_dump(mode="python"), dumped)
            # A `PydanticSerializationError`, a `ValueError`: a value or a dict key JSON cannot hold, or a `bytes`
            # field that is not UTF-8.
            except ValueError as e:
                return ("output_invalid", _describe(e)), output
            if lossy is not None:
                return ("output_invalid", lossy), output
            output = dumped
    except SkillError as e:
        return ("skill_retryable" if e.retryable else "skill_failed", f"{e.kind}: {e.message}"), None
    return None, output
