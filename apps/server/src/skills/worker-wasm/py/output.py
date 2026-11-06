# The wasm runner's output encoder. `pyodide-worker.ts` runs this file in the
# Pyodide globals the skill body shares and encodes what `run` returned with
# `_cogmo_encode_output`; the container tier's runner encodes the same way.

import json as _cogmo_json

# The largest integer the host's JSON.parse carries exactly.
_COGMO_MAX_SAFE_INTEGER = 2**53 - 1


def _cogmo_unsafe_int(value):
    """The first integer in `value` the host would round, or None."""
    pending = [value]
    while pending:
        item = pending.pop()
        if isinstance(item, bool):
            continue
        if isinstance(item, int):
            if abs(item) > _COGMO_MAX_SAFE_INTEGER:
                return item
        elif isinstance(item, dict):
            pending.extend(item.values())
        elif isinstance(item, (list, tuple)):
            pending.extend(item)
    return None


def _cogmo_encode_output(value):
    """`value` as JSON, or raise if JSON cannot carry it to the host intact.

    `allow_nan=False` refuses `NaN` and the infinities; a `set` or another
    unknown type raises `TypeError`, a cycle `ValueError`, and an integer past
    2**53 `ValueError`, since the host would round it.
    """
    encoded = _cogmo_json.dumps(value, allow_nan=False)
    unsafe = _cogmo_unsafe_int(value)
    if unsafe is not None:
        raise ValueError(f"integer {unsafe} is past 2**53, which JSON rounds; return it as a string")
    return encoded
