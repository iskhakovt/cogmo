"""Register's CPython checks (`cogmo_skills_runtime.check`), with the tools from this project's environment.

The tools run from this environment's `bin/`, at the toolchain's pins, against a toolchain directory holding
`cogmo_ctx` as the image's does. A skill venv is a directory of distributions laid out as an installer leaves them.
"""

import builtins
import io
import json
import os
import shutil
import subprocess
import sys
import sysconfig
from collections.abc import Callable, Mapping
from pathlib import Path

import pytest

from cogmo_skills_runtime import check, supervisor
from cogmo_skills_runtime.check import Toolchain

from .distributions import install
from .pragma_cases import PRAGMAS, REFUSED

type ProtocolCheck = Callable[[str, object], None]

_IMAGE = Path(__file__).parent.parent
_UNTRACKED = shutil.ignore_patterns("__pycache__", "*.py[co]")
_BIN = Path(sys.executable).parent
_HASH = "c" * 64
_MINOR = f"{sys.version_info.major}.{sys.version_info.minor}"
_FORMAT_FIX = "`uv run ruff format skills/<name>`"


@pytest.fixture
def toolchain(tmp_path: Path) -> Toolchain:
    """The toolchain as the image bakes it, `cogmo_ctx` joined into `.cogmo/`."""
    root = tmp_path / "toolchain"
    root.mkdir()
    shutil.copy(_IMAGE / "toolchain" / "pyproject.toml", root / "pyproject.toml")
    shutil.copytree(_IMAGE / "toolchain" / ".cogmo", root / ".cogmo", ignore=_UNTRACKED)
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


def _suppressions(reply: Mapping[str, object]) -> list[tuple[str, str, int]]:
    assert reply["type"] == "check_findings", reply
    suppressions = reply["suppressions"]
    assert isinstance(suppressions, list)
    return [(s["tool"], s["code"], s["line"]) for s in suppressions]


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
    assert reply == {"type": "check_findings", "findings": [], "suppressions": [], "toolchainVersion": "9.9.9-test"}


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


@pytest.mark.parametrize(
    ("body", "finding"),
    [
        # The compiler's offset counts UTF-8 bytes: `await` is the 15th code point, the 19th byte, the 16th UTF-16 unit.
        ('def f():\n    s = "é😀"; await g()\n', ("syntax", 2, 16, "'await' outside async function")),
        # The symbol table's too: `nonlocal` is the 11th code point and the 15th byte.
        ('s = "é😀"; nonlocal x\n', ("syntax", 1, 12, "nonlocal declaration not allowed at module level")),
    ],
)
def test_a_compile_error_after_non_ascii_text_is_positioned_in_utf16_units(
    toolchain: Toolchain, body: str, finding: tuple[str, int, int, str]
) -> None:
    reply = _check(body, toolchain)

    assert _findings(reply) == [finding]


def test_a_body_holding_a_null_byte_is_a_finding_about_the_file(toolchain: Toolchain) -> None:
    reply = _check("x = 1\x00\n", toolchain)

    assert _findings(reply) == [("syntax", None, None, "source code string cannot contain null bytes")]


@pytest.mark.parametrize("stage", ["parse", "compile"])
def test_a_body_too_deep_for_a_compile_stage_is_a_finding_about_the_file(
    toolchain: Toolchain, monkeypatch: pytest.MonkeyPatch, stage: str
) -> None:
    # `ast.parse` compiles too, so the compile stage's fake shadows `compile` in `check` alone.
    real: Callable[..., object] = check.ast.parse if stage == "parse" else builtins.compile

    def too_deep(source: object, filename: str, *args: object, **kwargs: object) -> object:
        if filename == "skill.py":
            raise RecursionError("maximum recursion depth exceeded")
        return real(source, filename, *args, **kwargs)

    if stage == "parse":
        monkeypatch.setattr(check.ast, "parse", too_deep)
    else:
        monkeypatch.setattr(check, "compile", too_deep, raising=False)

    reply = _check(_CLEAN, toolchain)

    assert _findings(reply) == [("syntax", None, None, "CPython could not compile it: RecursionError")]


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
    # ruff, `ruff format` and pyrefly count code points: `;` is the 13th and `undefined_name` starts at the 19th.
    body = 'async def run(inputs, ctx):\n    s = "é😀"; x = undefined_name\n    return s, x\n'

    reply = _check(body, toolchain)

    assert _findings(reply) == [
        ("ruff", 2, 14, "E702 Multiple statements on one line (semicolon)"),
        ("ruff", 2, 20, "F821 Undefined name `undefined_name`"),
        ("format", 2, 14, f"unformatted File would be reformatted: run {_FORMAT_FIX}"),
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


# --- format


def test_a_body_the_formatter_would_change_is_one_finding_at_its_first_difference(
    toolchain: Toolchain, protocol: ProtocolCheck
) -> None:
    # The formatter would change lines 1 and 4; ruff reports the first difference alone, in code points.
    body = 's = "é😀";  x = 1\n\n\ny = [1,2]\n'

    reply = _check(body, toolchain)

    protocol("check_reply", reply)
    assert [f for f in _findings(reply) if f[0] == "format"] == [
        ("format", 1, 10, f"unformatted File would be reformatted: run {_FORMAT_FIX}")
    ]


def test_the_formatter_reads_the_toolchains_line_length(toolchain: Toolchain) -> None:
    # Past ruff format's default 88 columns, within the toolchain's 120.
    body = f"X = [{', '.join(['1000000'] * 11)}, 1234]\n"
    assert 88 < len(body.rstrip()) <= 120

    reply = _check(body, toolchain)

    assert _findings(reply) == []


@pytest.mark.parametrize(
    ("script", "error"),
    [
        ("echo 'ruff: config unreadable' >&2; exit 2", "ruff format exited 2: ruff: config unreadable"),
        ("echo '{not json'; exit 1", "ruff format exited 1 with output that is not its JSON"),
        ("echo '[]'; exit 1", "ruff format exited 1 with no diagnostic"),
    ],
)
def test_a_ruff_format_failure_status_is_fatal(
    toolchain: Toolchain, tmp_path: Path, protocol: ProtocolCheck, script: str, error: str
) -> None:
    # `ruff check` runs as itself; `ruff format` runs the script.
    ruff = tmp_path / "ruff"
    ruff.write_text(f'#!/bin/sh\nif [ "$1" = format ]; then {script}; fi\nexec {toolchain.ruff} "$@"\n')
    ruff.chmod(0o755)

    reply = _check(_CLEAN, Toolchain(**{**toolchain.__dict__, "ruff": str(ruff)}))

    protocol("check_reply", reply)
    assert reply["type"] == "fatal"
    assert str(reply["error"]).startswith(error)


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
    install(site_packages, "Greeting-Kit", {"greeting/__init__.py": _GREETING, "greeting/py.typed": ""})
    body = "from greeting import greet\n\n\nasync def run(inputs, ctx):\n    return greet()\n"

    reply = _check(body, toolchain, ["greeting-kit==1.0"], _HASH)

    # pyrefly resolves it from the skill venv too.
    assert _findings(reply) == []


def test_a_module_only_a_transitive_dependency_installs_is_refused(toolchain: Toolchain, venvs: Path) -> None:
    site_packages = _site_packages(venvs, _HASH)
    install(site_packages, "greeting-kit", {"greeting/__init__.py": _GREETING})
    install(site_packages, "idna", {"idna/__init__.py": _GREETING})
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


def test_a_namespace_package_lets_through_only_what_a_declared_dependency_installs_beneath_it(
    toolchain: Toolchain, venvs: Path
) -> None:
    # Neither installs `google/__init__.py`: `google` is a PEP 420 namespace both install beneath.
    site_packages = _site_packages(venvs, _HASH)
    install(site_packages, "protobuf", {"google/protobuf/__init__.py": "", "google/_upb/_message.abi3.so": ""})
    install(site_packages, "google-auth", {"google/auth/__init__.py": "", "google/oauth2/__init__.py": ""})
    body = (
        "import google\n"
        "import google.protobuf.message\n"
        "from google import protobuf, oauth2\n"
        "import google.auth\n"
        "from google._upb import _message\n"
    )

    reply = _check(body, toolchain, ["protobuf==6.33.1"], _HASH)

    transitive = "which no declared dependency names; declare every package the skill imports"
    assert [f for f in _findings(reply) if f[0] == "imports"] == [
        ("imports", 3, 1, f"'google.oauth2' is installed by 'google-auth', {transitive}"),
        ("imports", 4, 1, f"'google.auth' is installed by 'google-auth', {transitive}"),
    ]


def test_a_shared_init_is_a_namespace_a_from_import_reaches_through(toolchain: Toolchain, venvs: Path) -> None:
    # Both install `zope/__init__.py`: a pkgutil-style namespace, which neither answers for alone.
    site_packages = _site_packages(venvs, _HASH)
    install(site_packages, "zope-interface", {"zope/__init__.py": "", "zope/interface/__init__.py": ""})
    install(site_packages, "zope-event", {"zope/__init__.py": "", "zope/event/__init__.py": ""})
    body = "import zope\nimport zope.interface\nimport zope.event\nfrom zope import event, interface\n"

    reply = _check(body, toolchain, ["zope-interface==1.0"], _HASH)

    transitive = "which no declared dependency names; declare every package the skill imports"
    assert [f for f in _findings(reply) if f[0] == "imports"] == [
        ("imports", 3, 1, f"'zope.event' is installed by 'zope-event', {transitive}"),
        ("imports", 4, 1, f"'zope.event' is installed by 'zope-event', {transitive}"),
    ]


def test_a_name_from_a_declared_regular_package_may_be_its_attribute(toolchain: Toolchain, venvs: Path) -> None:
    # `alpha`'s `__init__`s, `alpha`'s alone, define `b` and `c`, which `from` reads first; `alpha-extras` installs
    # modules of those names inside them, which only `import` reaches.
    site_packages = _site_packages(venvs, _HASH)
    install(site_packages, "alpha", {"alpha/__init__.py": "b = 42\n", "alpha/inner/__init__.py": "c = 1\n"})
    install(site_packages, "alpha-extras", {"alpha/b.py": "", "alpha/inner/c.py": ""})
    body = "from alpha import b\nfrom alpha.inner import c\nimport alpha.b\nimport alpha.inner.c\n"

    reply = _check(body, toolchain, ["alpha==1.0"], _HASH)

    transitive = "which no declared dependency names; declare every package the skill imports"
    assert [f for f in _findings(reply) if f[0] == "imports"] == [
        ("imports", 3, 1, f"'alpha.b' is installed by 'alpha-extras', {transitive}"),
        ("imports", 4, 1, f"'alpha.inner.c' is installed by 'alpha-extras', {transitive}"),
    ]


def test_an_init_several_distributions_list_is_none_of_theirs_alone(toolchain: Toolchain, venvs: Path) -> None:
    # Both list `a/ns/__init__.py`, so `a.ns` is neither's alone; `b` beneath it is `transitive`'s.
    site_packages = _site_packages(venvs, _HASH)
    install(site_packages, "direct", {"a/ns/__init__.py": "", "a/ns/direct.py": ""})
    install(site_packages, "transitive", {"a/__init__.py": "", "a/ns/__init__.py": "", "a/ns/b/__init__.py": ""})
    body = "from a.ns import b\nimport a.ns.b\nfrom a.ns import direct\n"

    reply = _check(body, toolchain, ["direct==1.0"], _HASH)

    transitive = "which no declared dependency names; declare every package the skill imports"
    assert [f for f in _findings(reply) if f[0] == "imports"] == [
        ("imports", 1, 1, f"'a.ns.b' is installed by 'transitive', {transitive}"),
        ("imports", 2, 1, f"'a.ns.b' is installed by 'transitive', {transitive}"),
    ]


def test_a_dependency_without_its_skill_venv_is_fatal(toolchain: Toolchain, venvs: Path) -> None:
    reply = _check(_CLEAN, toolchain, ["idna==3.10"], _HASH)

    assert reply["type"] == "fatal"
    assert str(reply["error"]).startswith("the skill venv has no site-packages at ")


def _replace_imports_rule(toolchain: Toolchain, scan: str) -> None:
    """Replace the toolchain's Imports rule with one whose `scan` has the body `scan`."""
    (Path(toolchain.config).parent / ".cogmo" / "imports.py").write_text(
        "import collections\n"
        "Refusal = collections.namedtuple('Refusal', 'line column message')\n"
        "def installed_modules(site_packages):\n    return {}\n"
        f"def scan(source, dependencies, installed):\n{scan}"
    )


def test_the_imports_rule_is_the_toolchains(toolchain: Toolchain) -> None:
    _replace_imports_rule(toolchain, "    return [Refusal(2, 1, 'the toolchain refuses this')]\n")

    reply = _check(_CLEAN, toolchain)

    assert _findings(reply) == [("imports", 2, 1, "the toolchain refuses this")]


def test_a_toolchain_without_its_imports_rule_is_fatal(toolchain: Toolchain) -> None:
    (Path(toolchain.config).parent / ".cogmo" / "imports.py").unlink()

    reply = _check(_CLEAN, toolchain)

    assert reply["type"] == "fatal"
    assert str(reply["error"]).startswith("the toolchain's Imports rule did not load: ")


def test_an_imports_rule_that_cannot_read_the_body_is_fatal(toolchain: Toolchain) -> None:
    _replace_imports_rule(toolchain, "    raise RecursionError('maximum recursion depth exceeded')\n")

    reply = _check(_CLEAN, toolchain)

    assert reply["type"] == "fatal"
    assert str(reply["error"]).startswith("the Imports rule could not read the body: RecursionError")


# --- suppressions


_BAD_RETURN = 'def f() -> int:\n    return "x"'
_NOT_INT = "bad-return Returned type `Literal['x']` is not assignable to declared return type `int`"
_RUFF_PER_LINE = "suppress per line, naming the rule: `# noqa: <code>`"
_PYREFLY_PER_LINE = "suppress per line, naming the error: `# pyrefly: ignore[<error>]`"


@pytest.mark.parametrize(
    ("body", "findings"),
    [
        (
            "# ruff: noqa\nimport os\n",
            [
                ("ruff", 1, 1, "PGH004 Use specific rule codes when using `ruff: noqa`"),
                ("suppression", 1, 1, f"`# ruff: noqa` exempts the whole file; {_RUFF_PER_LINE}"),
            ],
        ),
        (
            "import os\n# ruff: noqa: F401\n",
            [("suppression", 2, 1, f"`# ruff: noqa` exempts the whole file; {_RUFF_PER_LINE}")],
        ),
        (
            "# flake8: noqa: F401\nimport os\n",
            [("suppression", 1, 1, f"`# flake8: noqa` exempts the whole file; {_RUFF_PER_LINE}")],
        ),
        (
            "# ruff: file-ignore[F401]\nimport os\n",
            [("suppression", 1, 1, f"`# ruff: file-ignore` exempts the whole file; {_RUFF_PER_LINE}")],
        ),
        (
            "# ruff: disable[F401]\nimport os\n",
            [("suppression", 1, 1, f"`# ruff: disable` exempts the lines after it; {_RUFF_PER_LINE}")],
        ),
        # ruff ignores a file-wide pragma that is not on its own line; it is refused all the same.
        (
            's = "é😀"  # see # ruff: noqa\n',
            [("suppression", 1, 18, f"`# ruff: noqa` exempts the whole file; {_RUFF_PER_LINE}")],
        ),
        ("import os  # noqa\n", [("ruff", 1, 12, "PGH004 Use specific rule codes when using `noqa`")]),
        ("import os  # noqa F401\n", [("ruff", 1, 12, "PGH004 Use a colon when specifying `noqa` rule codes")]),
        (
            f"# pyrefly: ignore-errors\n{_BAD_RETURN}\n",
            [("suppression", 1, 1, f"`# pyrefly: ignore-errors` exempts the whole file; {_PYREFLY_PER_LINE}")],
        ),
        (
            f"{_BAD_RETURN}  # pyrefly: ignore\n",
            [("suppression", 2, 17, f"`# pyrefly: ignore` names no error; {_PYREFLY_PER_LINE}")],
        ),
        # pyrefly honors its own pragmas alone.
        (f"{_BAD_RETURN}  # type: ignore\n", [("pyrefly", 2, 12, _NOT_INT)]),
        (f"# type: ignore\n\n\n{_BAD_RETURN}\n", [("pyrefly", 5, 12, _NOT_INT)]),
        # A string is not a comment.
        (
            's = "# ruff: noqa"\nimport os\n',
            [
                ("ruff", 2, 1, "E402 Module level import not at top of file"),
                ("ruff", 2, 8, "F401 `os` imported but unused"),
            ],
        ),
    ],
)
def test_a_pragma_wider_than_its_line_or_naming_no_rule_is_refused(
    toolchain: Toolchain, protocol: ProtocolCheck, body: str, findings: list[tuple[str, int, int, str]]
) -> None:
    reply = _check(body, toolchain)

    protocol("check_reply", reply)
    assert _findings(reply) == findings


@pytest.mark.parametrize(
    ("body", "suppressions"),
    [
        ("import os  # noqa: F401\n", [("ruff", "F401", 1)]),
        ("import os, sys  # NOQA:E401,F401 because\n", [("ruff", "E401", 1), ("ruff", "F401", 1)]),
        ("# ruff: ignore[F401]\nimport os\n", [("ruff", "F401", 1)]),
        ("import os  # why # ruff: ignore[F401]\n", [("ruff", "F401", 1)]),
        (f"{_BAD_RETURN}  # pyrefly: ignore[bad-return]\n", [("pyrefly", "bad-return", 2)]),
        ('def f() -> int:\n    # pyrefly: ignore[bad-return]\n    return "x"\n', [("pyrefly", "bad-return", 2)]),
        # ruff reads a comment's first `noqa` alone.
        ("import os  # noqa: F401 # noqa: E501\n", [("ruff", "F401", 1)]),
        # Only a `noqa` naming RUF100 silences it, and it is recorded as any suppression is.
        ("x = 1  # noqa: E501, RUF100\n", [("ruff", "E501", 1), ("ruff", "RUF100", 1)]),
    ],
)
def test_a_suppression_naming_its_rule_on_its_line_passes_and_is_recorded(
    toolchain: Toolchain, protocol: ProtocolCheck, body: str, suppressions: list[tuple[str, str, int]]
) -> None:
    reply = _check(body, toolchain)

    protocol("check_reply", reply)
    assert _findings(reply) == []
    assert _suppressions(reply) == suppressions


@pytest.mark.parametrize(
    ("body", "finding"),
    [
        ("x = 1  # noqa: E501\n", ("ruff", 1, 8, "RUF100 Unused `noqa` directive (unused: `E501`)")),
        ("# ruff: ignore[E501]\nx = 1\n", ("ruff", 1, 1, "RUF100 Unused suppression (unused: `E501`)")),
        ("x = 1  # noqa: XYZ123\n", ("ruff", 1, 8, "RUF102 Invalid rule code in `# noqa`: XYZ123")),
        (
            "x = 1  # pyrefly: ignore[bad-return]\n",
            ("pyrefly", 1, 8, "unused-ignore Unused `# pyrefly: ignore` comment for code(s): bad-return"),
        ),
    ],
)
def test_a_suppression_that_suppresses_nothing_is_a_finding(
    toolchain: Toolchain, body: str, finding: tuple[str, int, int, str]
) -> None:
    reply = _check(body, toolchain)

    assert _findings(reply) == [finding]


def test_a_formatter_pragma_is_refused_and_records_no_suppression(
    toolchain: Toolchain, protocol: ProtocolCheck
) -> None:
    # Each as `ruff format` honours it, so the formatter finds nothing to change.
    body = (
        "# fmt: offline, a comment that names no pragma\n"
        "y = [1,2]  # fmt:skip\n"
        "# fmt: off\n"
        "x = [1,2]\n"
        "# fmt: on\n"
        "# yapf: disable\n"
        "z = [1,2]\n"
        "# yapf: enable\n"
    )

    reply = _check(body, toolchain)

    def refused(pragma: str) -> str:
        return f"`# {pragma}` exempts code from `ruff format`, whose layout every skill keeps"

    protocol("check_reply", reply)
    assert _findings(reply) == [
        ("suppression", 2, 12, refused("fmt:skip")),
        ("suppression", 3, 1, refused("fmt: off")),
        ("suppression", 5, 1, refused("fmt: on")),
        ("suppression", 6, 1, refused("yapf: disable")),
        ("suppression", 8, 1, refused("yapf: enable")),
    ]
    assert _suppressions(reply) == []


def test_it_refuses_the_pragmas_the_shared_table_refuses(toolchain: Toolchain) -> None:
    refused = {name for name, (body, _) in PRAGMAS.items() if _findings(_check(body, toolchain))}

    assert refused == REFUSED


def test_more_suppressions_than_a_file_may_carry_are_refused(toolchain: Toolchain) -> None:
    reply = _check("assert True  # noqa: S101\n" * 101, toolchain)

    assert _findings(reply) == [
        ("suppression", 101, 14, "more than 100 suppressions; fix what they suppress instead"),
    ]
    assert _suppressions(reply) == [("ruff", "S101", line) for line in range(1, 101)]


def test_a_toolchain_without_its_suppression_rule_is_fatal(toolchain: Toolchain) -> None:
    (Path(toolchain.config).parent / ".cogmo" / "suppressions.py").unlink()

    reply = _check(_CLEAN, toolchain)

    assert reply["type"] == "fatal"
    assert str(reply["error"]).startswith("the toolchain's suppression rule did not load: ")


def test_a_suppression_rule_that_cannot_read_the_body_is_fatal(toolchain: Toolchain) -> None:
    rule = Path(toolchain.config).parent / ".cogmo" / "suppressions.py"
    rule.write_text(
        "import tokenize\n\n\ndef scan(source):\n    raise tokenize.TokenError('EOF in multi-line string')\n"
    )

    reply = _check(_CLEAN, toolchain)

    assert reply["type"] == "fatal"
    assert str(reply["error"]).startswith("the suppression rule could not read the body: ")


# --- the reply


def test_a_flood_of_findings_is_capped_so_the_reply_fits_what_the_host_reads(toolchain: Toolchain) -> None:
    # Each line names an undefined `a` 50 times and runs past 120 columns: per line, ruff's 50 F821 and one E501,
    # pyrefly's 50 unknown-name; with the formatter's one, 30 301 findings in all.
    body = ("x = (" + ", ".join(["a"] * 50) + ")\n") * 300

    reply = _check(body, toolchain)

    findings = _findings(reply)
    assert len(json.dumps(reply)) < 1024 * 1024
    assert len(findings) == 103
    assert {check_id for check_id, *_ in findings[:100]} == {"ruff"}
    assert findings[100:] == [
        ("ruff", None, None, "and 15200 more ruff findings"),
        ("format", None, None, "and 1 more format findings"),
        ("pyrefly", None, None, "and 15000 more pyrefly findings"),
    ]


def test_a_long_message_is_cut(toolchain: Toolchain) -> None:
    reply = _check(f"x = {'a' * 1000}\n", toolchain)

    messages = {
        check_id: message for check_id, _, _, message in _findings(reply) if check_id != "ruff" or "F821" in message
    }
    assert set(messages) == {"ruff", "pyrefly"}
    for message in messages.values():
        assert len(message) == 400
        assert message.endswith("…")


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
