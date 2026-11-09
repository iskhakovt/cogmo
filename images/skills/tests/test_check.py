"""Register's CPython checks (`cogmo_skills_runtime.check`), with the tools from this project's environment.

The tools run from this environment's `bin/`, at the toolchain's pins, against a toolchain directory holding
`cogmo_ctx` as the image's does. A skill venv is a directory of distributions laid out as an installer leaves them.
"""

import base64
import hashlib
import io
import json
import os
import shutil
import subprocess
import sys
import sysconfig
from collections.abc import Callable, Mapping
from pathlib import Path, PurePosixPath

import pytest

from cogmo_skills_runtime import check, supervisor
from cogmo_skills_runtime.check import Toolchain

type ProtocolCheck = Callable[[str, object], None]

_IMAGE = Path(__file__).parent.parent
_UNTRACKED = shutil.ignore_patterns("__pycache__", "*.py[co]")
_BIN = Path(sys.executable).parent
_HASH = "c" * 64
_MINOR = f"{sys.version_info.major}.{sys.version_info.minor}"


@pytest.fixture
def toolchain(tmp_path: Path) -> Toolchain:
    """The toolchain as the image bakes it, `cogmo_ctx` joined into `.cogmo/`."""
    root = tmp_path / "toolchain"
    root.mkdir()
    shutil.copy(_IMAGE / "toolchain" / "pyproject.toml", root / "pyproject.toml")
    shutil.copytree(_IMAGE / "src" / "cogmo_ctx", root / ".cogmo" / "cogmo_ctx", ignore=_UNTRACKED)
    return Toolchain(
        ruff=str(_BIN / "ruff"),
        pyrefly=str(_BIN / "pyrefly"),
        config=str(root / "pyproject.toml"),
        site_packages=sysconfig.get_path("purelib"),
        version="9.9.9-test",
    )


@pytest.fixture
def venvs(tmp_path: Path, monkeypatch: pytest.MonkeyPatch) -> Path:
    root = tmp_path / "skill-venvs"
    root.mkdir()
    monkeypatch.setattr(supervisor, "SKILL_VENVS_ROOT", os.fspath(root))
    return root


def _site_packages(venvs: Path, lockfile_hash: str) -> Path:
    return venvs / f"{lockfile_hash}-py{_MINOR}" / "lib" / f"python{_MINOR}" / "site-packages"


def _install(site_packages: Path, name: str, files: Mapping[str, str]) -> None:
    """Lay `name`'s `files` out in `site_packages` as an installer does, with a `RECORD` listing each."""
    dist_info = f"{name.replace('-', '_')}-1.0.dist-info"
    everything = {**files, f"{dist_info}/METADATA": f"Metadata-Version: 2.1\nName: {name}\nVersion: 1.0\n"}
    records = []
    for relative, content in everything.items():
        path = site_packages / relative
        if not relative.startswith(".."):
            path.parent.mkdir(parents=True, exist_ok=True)
            path.write_text(content)
        digest = base64.urlsafe_b64encode(hashlib.sha256(content.encode()).digest()).rstrip(b"=").decode()
        records.append(f"{relative},sha256={digest},{len(content)}")
    records.append(f"{dist_info}/RECORD,,")
    (site_packages / dist_info / "RECORD").write_text("\n".join(records) + "\n")


def _check(
    body: str, toolchain: Toolchain, dependencies: list[str] | None = None, lockfile_hash: str | None = None
) -> dict[str, object]:
    request = {"body": body, "dependencies": dependencies or [], "lockfileHash": lockfile_hash}
    stdout = io.StringIO()
    check.main(io.StringIO(json.dumps(request)), stdout, lambda: toolchain)
    lines = stdout.getvalue().splitlines()
    assert len(lines) == 1, stdout.getvalue()
    return json.loads(lines[0])


def _findings(reply: Mapping[str, object]) -> list[tuple[str, int | None, int | None, str]]:
    assert reply["type"] == "check_findings", reply
    findings = reply["findings"]
    assert isinstance(findings, list)
    return [(f["id"], f["line"], f["column"], f["message"]) for f in findings]


_CLEAN = """\
import json

from pydantic import BaseModel

from cogmo_ctx import Ctx, SkillError


class Input(BaseModel):
    url: str


class Output(BaseModel):
    status: int


async def run(inputs: Input, ctx: Ctx) -> Output:
    response = await ctx.http.get(inputs.url)
    if response["status"] >= 500:
        raise SkillError("upstream", json.dumps(response["status"]), retryable=True)
    return Output(status=response["status"])
"""


def test_a_skill_that_passes_has_no_findings_and_names_the_toolchain(
    toolchain: Toolchain, protocol: ProtocolCheck
) -> None:
    reply = _check(_CLEAN, toolchain)

    protocol("check_reply", reply)
    assert reply == {"type": "check_findings", "findings": [], "toolchainVersion": "9.9.9-test"}


def test_the_request_the_host_sends_is_a_check_request(protocol: ProtocolCheck) -> None:
    protocol("check_request", {"body": _CLEAN, "dependencies": ["idna==3.10"], "lockfileHash": _HASH})
    protocol("check_request", {"body": _CLEAN, "dependencies": [], "lockfileHash": None})


# --- syntax


def test_a_syntax_error_is_the_only_finding(toolchain: Toolchain, protocol: ProtocolCheck) -> None:
    # ruff, pyrefly and the import check would each also flag this body.
    reply = _check("import requests\nx = (1 2)\n", toolchain)

    protocol("check_reply", reply)
    assert _findings(reply) == [("syntax", 2, 6, "invalid syntax. Perhaps you forgot a comma?")]


def test_a_syntax_error_after_non_ascii_text_is_positioned_in_utf16_units(toolchain: Toolchain) -> None:
    # CPython's offset counts code points: `(` is the 15th, `1` the 16th; the astral 😀 is two UTF-16 units.
    reply = _check('s = "é😀"; y = (1 2)\n', toolchain)

    assert _findings(reply) == [("syntax", 1, 17, "invalid syntax. Perhaps you forgot a comma?")]


def test_a_body_holding_a_null_byte_is_a_finding_about_the_file(toolchain: Toolchain) -> None:
    reply = _check("x = 1\x00\n", toolchain)

    assert _findings(reply) == [("syntax", None, None, "source code string cannot contain null bytes")]


def test_a_body_the_compile_cannot_nest_is_a_finding_about_the_file(toolchain: Toolchain) -> None:
    reply = _check("x = " + "(" * 300 + ")" * 300 + "\n", toolchain)

    [(check_id, line, _, message)] = _findings(reply)
    assert (check_id, line) == ("syntax", 1)
    assert "parenthes" in message or "nested" in message


# --- ruff


def test_ruff_findings_lead_with_their_rule(toolchain: Toolchain) -> None:
    body = _CLEAN.replace(
        "    response = await ctx.http.get(inputs.url)\n",
        "    try:\n"
        "        response = await ctx.http.get(inputs.url)\n"
        "    except KeyError as e:\n"
        '        raise SkillError("missing", str(e))\n',
    )

    reply = _check(body, toolchain)

    assert _findings(reply) == [
        (
            "ruff",
            20,
            9,
            "B904 Within an `except` clause, raise exceptions with `raise ... from err` or `raise ... from None` "
            "to distinguish them from errors in exception handling",
        )
    ]


def test_ruff_reads_the_toolchains_line_length(toolchain: Toolchain) -> None:
    reply = _check(f'X = "{"a" * 120}"\n', toolchain)

    assert _findings(reply) == [("ruff", 1, 121, "E501 Line too long (126 > 120)")]


def test_tool_columns_on_a_non_ascii_line_are_utf16_units(toolchain: Toolchain) -> None:
    # ruff and pyrefly count code points: `;` is the 13th and `undefined_name` starts at the 19th.
    body = 'async def run(inputs, ctx):\n    s = "é😀"; x = undefined_name\n    return s, x\n'

    reply = _check(body, toolchain)

    assert _findings(reply) == [
        ("ruff", 2, 14, "E702 Multiple statements on one line (semicolon)"),
        ("ruff", 2, 20, "F821 Undefined name `undefined_name`"),
        ("pyrefly", 2, 20, "unknown-name Could not find name `undefined_name`"),
    ]


@pytest.mark.parametrize(
    ("script", "error"),
    [
        ("echo 'ruff: config unreadable' >&2; exit 2", "ruff exited 2: ruff: config unreadable"),
        ("echo '{not json'; exit 1", "ruff exited 1 with output that is not its JSON"),
        ("kill -9 $$", "ruff exited -9"),
    ],
)
def test_a_ruff_failure_status_is_fatal(
    toolchain: Toolchain, tmp_path: Path, protocol: ProtocolCheck, script: str, error: str
) -> None:
    ruff = tmp_path / "ruff"
    ruff.write_text(f"#!/bin/sh\n{script}\n")
    ruff.chmod(0o755)

    reply = _check(_CLEAN, Toolchain(**{**toolchain.__dict__, "ruff": str(ruff)}))

    protocol("check_reply", reply)
    assert reply["type"] == "fatal"
    assert str(reply["error"]).startswith(error)


def test_a_ruff_that_does_not_start_is_fatal(toolchain: Toolchain, tmp_path: Path) -> None:
    reply = _check(_CLEAN, Toolchain(**{**toolchain.__dict__, "ruff": str(tmp_path / "absent")}))

    assert reply["type"] == "fatal"
    assert str(reply["error"]).startswith("absent did not start: ")


# --- pyrefly


def test_pyrefly_findings_lead_with_their_name(toolchain: Toolchain) -> None:
    body = _CLEAN.replace('    return Output(status=response["status"])', '    return response["status"]')

    reply = _check(body, toolchain)

    assert _findings(reply) == [
        ("pyrefly", 20, 12, "bad-return Returned type `int` is not assignable to declared return type `Output`"),
    ]


def test_pyrefly_types_ctx_against_cogmo_ctx(toolchain: Toolchain) -> None:
    body = _CLEAN.replace("ctx.http.get(inputs.url)", "ctx.web.get(inputs.url)")

    reply = _check(body, toolchain)

    assert _findings(reply) == [("pyrefly", 17, 22, "missing-attribute Object of class `Ctx` has no attribute `web`")]


@pytest.mark.parametrize(
    ("script", "error"),
    [
        ("echo 'pyrefly: panic' >&2; exit 101", "pyrefly exited 101: pyrefly: panic"),
        ("echo '{\"errs\": []}'; exit 1", "pyrefly exited 1 with output that is not its JSON"),
    ],
)
def test_a_pyrefly_failure_status_is_fatal(toolchain: Toolchain, tmp_path: Path, script: str, error: str) -> None:
    pyrefly = tmp_path / "pyrefly"
    pyrefly.write_text(f"#!/bin/sh\n{script}\n")
    pyrefly.chmod(0o755)

    reply = _check(_CLEAN, Toolchain(**{**toolchain.__dict__, "pyrefly": str(pyrefly)}))

    assert reply["type"] == "fatal"
    assert str(reply["error"]).startswith(error)


# --- imports


_GREETING = "def greet() -> str:\n    return 'hi'\n"


def test_a_module_a_declared_dependency_installs_passes(toolchain: Toolchain, venvs: Path) -> None:
    site_packages = _site_packages(venvs, _HASH)
    _install(site_packages, "Greeting-Kit", {"greeting/__init__.py": _GREETING, "greeting/py.typed": ""})
    body = "from greeting import greet\n\n\nasync def run(inputs, ctx):\n    return greet()\n"

    reply = _check(body, toolchain, ["greeting-kit==1.0"], _HASH)

    # pyrefly resolves it from the skill venv too.
    assert _findings(reply) == []


def test_a_module_only_a_transitive_dependency_installs_is_refused(toolchain: Toolchain, venvs: Path) -> None:
    site_packages = _site_packages(venvs, _HASH)
    _install(site_packages, "greeting-kit", {"greeting/__init__.py": _GREETING})
    _install(site_packages, "idna", {"idna/__init__.py": _GREETING})
    body = "import idna\nfrom greeting import greet\n\n\nasync def run(inputs, ctx):\n    return greet(), idna\n"

    reply = _check(body, toolchain, ["greeting-kit==1.0"], _HASH)

    assert _findings(reply) == [
        (
            "imports",
            1,
            1,
            "'idna' is installed by 'idna', which no declared dependency names; "
            "declare every package the skill imports",
        )
    ]


def test_imports_outside_the_allowed_set_are_refused_where_they_stand(toolchain: Toolchain) -> None:
    body = (
        "from __future__ import annotations\n"
        "import os.path, requests.adapters\n"
        "import pydantic_core, cogmo_ctx.ctx_types\n"
        "from . import sibling\n"
        's = "é😀"; import yaml\n'
        "\n\nasync def run(inputs, ctx):\n"
        "    import numpy as np\n"
        "    return os.path, requests, pydantic_core, cogmo_ctx, sibling, s, yaml, np\n"
    )

    reply = _check(body, toolchain)

    imports = [f for f in _findings(reply) if f[0] == "imports"]
    not_allowed = (
        "is not the standard library, pydantic, pydantic_core, cogmo_ctx or a module a declared dependency installs"
    )
    assert imports == [
        ("imports", 2, 1, f"'requests' {not_allowed}"),
        ("imports", 4, 1, "a relative import, which a skill's one module cannot resolve"),
        # `import` is the 11th code point and the 12th UTF-16 unit; `ast` puts it at byte offset 14.
        ("imports", 5, 12, f"'yaml' {not_allowed}"),
        ("imports", 9, 5, f"'numpy' {not_allowed}"),
    ]


def test_a_dependency_without_its_skill_venv_is_fatal(toolchain: Toolchain, venvs: Path) -> None:
    reply = _check(_CLEAN, toolchain, ["idna==3.10"], _HASH)

    assert reply["type"] == "fatal"
    assert str(reply["error"]).startswith("the skill venv has no site-packages at ")


def test_record_paths_map_to_the_modules_they_install() -> None:
    suffix = next(s for s in check.importlib.machinery.EXTENSION_SUFFIXES if s != ".so")
    files = [
        "pkg/__init__.py",
        "pkg/sub/mod.py",
        "single.py",
        f"_native{suffix}",
        "_plain.so",
        "namespace/part/__init__.py",
        "py.typed",
        "LICENSE",
        "pkg-1.0.pth",
        "pkg-1.0.dist-info/METADATA",
        "pkg-1.0.data/scripts/tool",
        "__pycache__/single.cpython-314.pyc",
        "../../../bin/tool",
        "/etc/absolute",
    ]

    modules = check.record_modules(PurePosixPath(f) for f in files)

    assert modules == frozenset({"pkg", "single", "_native", "_plain", "namespace"})


def test_installed_distributions_are_keyed_by_their_pep_503_name(tmp_path: Path) -> None:
    site_packages = tmp_path / "site-packages"
    _install(site_packages, "My.Pkg_Name", {"my_pkg/__init__.py": "", "../../../bin/my-pkg": ""})
    no_record = site_packages / "bare-1.0.dist-info"
    no_record.mkdir()
    (no_record / "METADATA").write_text("Metadata-Version: 2.1\nName: Bare\nVersion: 1.0\n")

    installed = check.installed_modules(os.fspath(site_packages))

    assert installed == {"my-pkg-name": frozenset({"my_pkg"}), "bare": frozenset()}


# --- the reply


@pytest.mark.parametrize(
    "request_text",
    ["not json", json.dumps(["a list"]), json.dumps({"body": 1, "dependencies": [], "lockfileHash": None})],
)
def test_a_request_that_is_not_a_check_request_is_fatal(toolchain: Toolchain, request_text: str) -> None:
    stdout = io.StringIO()

    check.main(io.StringIO(request_text), stdout, lambda: toolchain)

    reply = json.loads(stdout.getvalue())
    assert reply["type"] == "fatal"
    assert reply["error"].startswith("the request is not")


def test_the_image_toolchain_reads_its_baked_version(tmp_path: Path, monkeypatch: pytest.MonkeyPatch) -> None:
    version = tmp_path / "VERSION"
    version.write_text("2.17.0\n")
    monkeypatch.setattr(check, "VERSION_FILE", os.fspath(version))

    assert check.image_toolchain().version == "2.17.0"
    assert check.image_toolchain().ruff == "/opt/cogmo-skills/tools/bin/ruff"
    assert check.image_toolchain().config == "/opt/cogmo-skills/toolchain/pyproject.toml"


@pytest.mark.parametrize("content", [None, "\n"])
def test_an_image_without_its_toolchain_version_is_fatal(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch, content: str | None
) -> None:
    version = tmp_path / "VERSION"
    if content is not None:
        version.write_text(content)
    monkeypatch.setattr(check, "VERSION_FILE", os.fspath(version))
    stdout = io.StringIO()

    check.main(
        io.StringIO(json.dumps({"body": "", "dependencies": [], "lockfileHash": None})), stdout, check.image_toolchain
    )

    reply = json.loads(stdout.getvalue())
    assert reply["type"] == "fatal"
    assert reply["error"].startswith("the image bakes no toolchain version")


def test_the_module_runs_as_the_host_starts_it() -> None:
    # Outside the image there is no baked version, so the one line it writes is `fatal`.
    result = subprocess.run(
        [sys.executable, "-I", "-m", "cogmo_skills_runtime.check"],
        input=json.dumps({"body": "", "dependencies": [], "lockfileHash": None}),
        capture_output=True,
        text=True,
        check=True,
    )

    [line] = result.stdout.splitlines()
    assert json.loads(line)["type"] == "fatal"
