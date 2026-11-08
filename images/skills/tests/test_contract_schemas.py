import json
from collections.abc import Callable, Mapping
from typing import Any

import jsonschema
import pytest
from pydantic import BaseModel, ConfigDict, Field, computed_field
from pydantic.errors import PydanticInvalidForJsonSchema

from cogmo_ctx import Ctx
from cogmo_ctx._run import call_run, contract_schemas

_RUN = {"id": "run-1", "key": "key-1"}


class _NoBridge:
    async def call(self, method: str, args: Mapping[str, object]) -> Any:
        raise AssertionError(f"no ctx call expected, got {method}")


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
    # The computed field is in what the host receives; the serialization alias is not, as the model's JSON
    # writes field names unless it serializes by alias.
    assert set(schemas["outputs"]["properties"]) == {"celsius", "fahrenheit"}


class AliasedOutput(BaseModel):
    model_config = ConfigDict(serialize_by_alias=True)

    celsius: float = Field(serialization_alias="tempC")


class AliasedInput(BaseModel):
    city: str = Field(alias="town")


class NamedInput(BaseModel):
    model_config = ConfigDict(validate_by_name=True, validate_by_alias=False)

    city: str = Field(alias="town")


@pytest.mark.parametrize("output_model", [Output, AliasedOutput])
async def test_what_run_returns_meets_the_output_schema(output_model: type[BaseModel]) -> None:
    async def run(inputs: object, ctx: Ctx) -> object:
        return {"celsius": 20.5}

    schema = json.loads(contract_schemas({"Output": output_model}))["outputs"]
    failure, output = await call_run({"Output": output_model}, run, {}, Ctx(_NoBridge(), _RUN))

    assert failure is None
    jsonschema.Draft202012Validator(schema).validate(output)


@pytest.mark.parametrize(("input_model", "field"), [(AliasedInput, "town"), (NamedInput, "city")])
async def test_inputs_the_input_schema_admits_input_accepts(input_model: type[BaseModel], field: str) -> None:
    async def run(inputs: object, ctx: Ctx) -> object:
        return None

    schema = json.loads(contract_schemas({"Input": input_model}))["inputs"]
    inputs = {field: "Paris"}
    jsonschema.Draft202012Validator(schema).validate(inputs)
    failure, _ = await call_run({"Input": input_model}, run, inputs, Ctx(_NoBridge(), _RUN))

    assert failure is None


class Tree(BaseModel):
    name: str
    children: list[Tree] = []


def test_a_model_that_refers_to_itself_states_its_root_type() -> None:
    schema = json.loads(contract_schemas({"Input": Tree}))["inputs"]

    assert schema["type"] == "object"
    assert "$ref" not in schema
    validator = jsonschema.Draft202012Validator(schema)
    validator.validate({"name": "root", "children": [{"name": "leaf"}]})
    assert not validator.is_valid({"name": "root", "children": [{"children": []}]})


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
