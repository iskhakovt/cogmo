"""How both tiers call a skill's `run`: under its `Input` and `Output` models, with a `SkillError` as a value.

The container runner and the wasm worker share this file, so a skill's contract holds the same on both
tiers (design/skills.md → Contracts).
"""

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


async def call_run(
    namespace: Mapping[str, object],
    run: Callable[[Any, Ctx], Awaitable[object]],
    inputs: object,
    ctx: Ctx,
) -> tuple[RunFailure | None, object]:
    """Call `run` under the skill's contract: `(None, output)`, or `(failure, kept)`.

    With an `Input` model, `run` receives `Input.model_validate(inputs)`, so pydantic applies defaults and
    coercion; a refusal is `input_invalid`. With an `Output` model, the output is
    `Output.model_validate(result).model_dump(mode="json")`; a refusal is `output_invalid`, and `kept` is what
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
            try:
                output = output_model.model_validate(output).model_dump(mode="json")
            # A `ValidationError`, a `PydanticSerializationError`, or the `UnicodeDecodeError` a `bytes` field
            # that is not UTF-8 raises in JSON mode: each is a `ValueError`.
            except ValueError as e:
                return ("output_invalid", _describe(e)), output
    except SkillError as e:
        return ("skill_retryable" if e.retryable else "skill_failed", f"{e.kind}: {e.message}"), None
    return None, output
