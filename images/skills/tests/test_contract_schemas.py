import json
from collections.abc import Callable

import pytest
from pydantic import BaseModel, Field, computed_field
from pydantic.errors import PydanticInvalidForJsonSchema

from cogmo_ctx._run import contract_schemas


class Input(BaseModel):
    city: str
    days: int = 3


class Output(BaseModel):
    celsius: float = Field(serialization_alias="tempC")

    @computed_field
    @property
    def fahrenheit(self) -> float:
        return self.celsius * 9 / 5 + 32


def test_a_skill_with_no_models_has_no_schemas() -> None:
    assert json.loads(contract_schemas({"run": object()})) == {"inputs": None, "outputs": None}


def test_input_is_what_validation_accepts_and_output_what_its_json_writes() -> None:
    schemas = json.loads(contract_schemas({"Input": Input, "Output": Output}))

    assert schemas["inputs"]["type"] == "object"
    assert schemas["inputs"]["required"] == ["city"]
    assert schemas["inputs"]["properties"]["days"]["default"] == 3
    # The serialization alias and the computed field are what the host receives.
    assert set(schemas["outputs"]["properties"]) == {"tempC", "fahrenheit"}


def test_each_model_stands_alone() -> None:
    schemas = json.loads(contract_schemas({"Output": Output}))

    assert schemas["inputs"] is None
    assert schemas["outputs"] is not None


def test_a_name_that_is_not_a_pydantic_model_is_no_schema() -> None:
    class Plain:
        pass

    assert json.loads(contract_schemas({"Input": Plain, "Output": {"type": "object"}})) == {
        "inputs": None,
        "outputs": None,
    }


def test_a_model_pydantic_cannot_describe_raises() -> None:
    class Hooked(BaseModel):
        hook: Callable[[], int]

    with pytest.raises(PydanticInvalidForJsonSchema):
        contract_schemas({"Input": Hooked})


def test_a_schema_json_cannot_carry_raises() -> None:
    class NotFinite(BaseModel):
        ratio: float = float("nan")

    with pytest.raises(ValueError, match="not JSON compliant"):
        contract_schemas({"Input": NotFinite})
