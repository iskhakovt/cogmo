# The wasm runner's output encoder. `pyodide-worker.ts` runs this file in the
# Pyodide globals the skill body shares and encodes what `run` returned with
# `_cogmo_encode_output`; the container tier's runner encodes the same way.

import json as _cogmo_json

# The largest integer the host's JSON.parse carries exactly.
_COGMO_MAX_SAFE_INTEGER = 2**53 - 1


def _cogmo_unsafe(value):
    """Why JSON would not carry `value` to the host intact, or None.

    An integer past 2**53 the host's `JSON.parse` would round; two keys of
    one dict that JSON writes alike (`1` and `"1"`) it would keep only one of.
    """
    pending = [value]
    while pending:
        item = pending.pop()
        if isinstance(item, bool):
            continue
        if isinstance(item, int):
            if abs(item) > _COGMO_MAX_SAFE_INTEGER:
                return f"integer {item} is past 2**53, which JSON rounds; return it as a string"
        elif isinstance(item, dict):
            names = {key if isinstance(key, str) else _cogmo_json.dumps(key) for key in item}
            if len(names) < len(item):
                return "two keys of one dict are written alike as JSON strings, so one would be lost"
            pending.extend(item.values())
        elif isinstance(item, (list, tuple)):
            pending.extend(item)
    return None


def _cogmo_encode_output(value):
    """`value` as JSON, or raise if JSON cannot carry it to the host intact.

    `allow_nan=False` refuses `NaN` and the infinities; a `set` or another
    unknown type raises `TypeError`, a cycle `ValueError`, and what the host
    would change (`_cogmo_unsafe`) `ValueError`.
    """
    encoded = _cogmo_json.dumps(value, allow_nan=False)
    unsafe = _cogmo_unsafe(value)
    if unsafe is not None:
        raise ValueError(unsafe)
    return encoded
