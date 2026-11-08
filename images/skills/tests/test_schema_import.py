import io
import json
import os
import sys
from collections.abc import Callable, Iterator
from pathlib import Path

import pytest

from cogmo_skills_runtime import schema, supervisor

type ProtocolCheck = Callable[[str, object], None]

_HASH = "b" * 64


@pytest.fixture(autouse=True)
def _restore_process_state(tmp_path: Path, monkeypatch: pytest.MonkeyPatch) -> Iterator[None]:
    """Venv activation edits `sys.path` and the environment; each test gets them back. Venvs live under `tmp_path`."""
    monkeypatch.setattr(supervisor, "SKILL_VENVS_ROOT", os.fspath(tmp_path))
    saved_path, saved_env = list(sys.path), dict(os.environ)
    yield
    sys.path[:] = saved_path
    os.environ.clear()
    os.environ.update(saved_env)


def _import(body: str, argv: list[str] | None = None) -> tuple[dict[str, object], str, str]:
    """Run the import on `body`: its one reply, then everything on stdout, then stderr."""
    stdout, stderr = io.StringIO(), io.StringIO()
    schema.main(argv or [], io.StringIO(body), stdout, stderr)
    lines = stdout.getvalue().splitlines()
    assert len(lines) == 1, stdout.getvalue()
    return json.loads(lines[0]), stdout.getvalue(), stderr.getvalue()


_MODELS = """
from pydantic import BaseModel

class Input(BaseModel):
    city: str

class Output(BaseModel):
    celsius: float

async def run(inputs, ctx):
    raise AssertionError("an import calls no run")
"""


def test_replies_with_the_models_schemas(protocol: ProtocolCheck) -> None:
    reply, _, _ = _import(_MODELS)

    protocol("schema_import_reply", reply)
    assert reply["type"] == "schemas"
    assert reply["inputs"] == {
        "properties": {"city": {"title": "City", "type": "string"}},
        "required": ["city"],
        "title": "Input",
        "type": "object",
    }
    assert reply["outputs"] is not None


def test_a_skill_with_no_models_has_no_schemas(protocol: ProtocolCheck) -> None:
    reply, _, _ = _import("async def run(inputs, ctx):\n    return None\n")

    protocol("schema_import_reply", reply)
    assert reply == {"type": "schemas", "inputs": None, "outputs": None}


@pytest.mark.parametrize(
    ("body", "error"),
    [
        ("def broken(:\n", "skill.py did not load: SyntaxError"),
        ("1 / 0\n", "skill.py did not load: ZeroDivisionError: division by zero"),
        ("import sys\nsys.exit(3)\n", "skill.py did not load: SystemExit: 3"),
    ],
)
def test_a_skill_that_does_not_load_fails(protocol: ProtocolCheck, body: str, error: str) -> None:
    reply, _, _ = _import(body)

    protocol("schema_import_reply", reply)
    assert reply["type"] == "schema_failed"
    assert str(reply["error"]).startswith(error)


def test_a_model_pydantic_cannot_describe_fails(protocol: ProtocolCheck) -> None:
    body = (
        "from collections.abc import Callable\nfrom pydantic import BaseModel\n\n"
        "class Input(BaseModel):\n    hook: Callable[[], int]\n"
    )

    reply, _, _ = _import(body)

    protocol("schema_import_reply", reply)
    assert reply["type"] == "schema_failed"
    assert str(reply["error"]).startswith("its models' JSON Schemas could not be written: PydanticInvalidForJsonSchema")


def test_module_prints_go_to_stderr_so_the_reply_is_the_only_line() -> None:
    reply, _, stderr = _import(f'print("hello from the module")\n{_MODELS}')

    assert reply["type"] == "schemas"
    assert "hello from the module" in stderr


def test_imports_from_the_skill_venv_named_by_the_lockfile_hash() -> None:
    venv = supervisor._skill_venv_path(_HASH)
    site_packages = os.path.join(
        venv, "lib", f"python{sys.version_info.major}.{sys.version_info.minor}", "site-packages"
    )
    os.makedirs(site_packages)
    with open(os.path.join(site_packages, "schema_venv_marker.py"), "w") as f:
        f.write("TITLE = 'FromVenv'\n")
    body = (
        "import schema_venv_marker\nfrom pydantic import BaseModel, ConfigDict\n\n"
        "class Input(BaseModel):\n    model_config = ConfigDict(title=schema_venv_marker.TITLE)\n    x: int\n"
    )

    reply, _, _ = _import(body, [_HASH])

    assert reply["type"] == "schemas"
    assert isinstance(reply["inputs"], dict)
    assert reply["inputs"]["title"] == "FromVenv"


def test_a_venv_that_does_not_activate_is_fatal(protocol: ProtocolCheck) -> None:
    reply, _, _ = _import(_MODELS, [_HASH])

    protocol("schema_import_reply", reply)
    assert reply["type"] == "fatal"
    assert str(reply["error"]).startswith("skill_venv: skill_venv has no site-packages")
