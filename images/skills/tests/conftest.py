"""The worker protocol's JSON Schemas, as a fixture every test file can check frames with.

`contract/worker-protocol.schema.json` is generated from Cogmo's Zod schemas by
`pnpm --filter cogmo codegen:ctx`, and a Cogmo unit test fails when it is stale.
A frame that fails it carries a field the host would strip or refuse.
"""

import json
from collections.abc import Callable
from pathlib import Path

import jsonschema
import pytest

_CONTRACT = Path(__file__).parent.parent / "contract" / "worker-protocol.schema.json"

type ProtocolCheck = Callable[[str, object], None]


@pytest.fixture(scope="session")
def contract_definitions() -> dict[str, object]:
    """The contract's `$defs`: each frame, and each ctx method's arguments and result."""
    return json.loads(_CONTRACT.read_text())["$defs"]


@pytest.fixture(scope="session")
def protocol(contract_definitions: dict[str, object]) -> ProtocolCheck:
    """`protocol(name, instance)` fails the test unless `instance` matches `$defs[name]`."""
    definitions = contract_definitions

    def check(name: str, instance: object) -> None:
        assert name in definitions, f"no {name} in the contract"
        validator = jsonschema.Draft202012Validator({"$ref": f"#/$defs/{name}", "$defs": definitions})
        problems = sorted(error.message for error in validator.iter_errors(instance))
        assert not problems, f"{name}: {problems}"

    return check
