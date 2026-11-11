"""`toolchain/.cogmo/suppressions.py`'s formatter pragmas, held to `ruff format` at the toolchain's pin.

The rule refuses a formatter pragma exactly where the formatter honours it. Each comment below, at each position, is
refused when the formatter keeps the layout of the code it governs, and only then, so a ruff bump that reads pragmas
differently fails here. The shared table (`pragma_cases.py`) holds both callers to the same verdicts.
"""

import importlib.util
import subprocess
import sys
from pathlib import Path
from types import ModuleType

import pytest

_TOOLCHAIN = Path(__file__).parent.parent / "toolchain"
_RUFF = Path(sys.executable).parent / "ruff"

# The mutation image has no toolchain/, and nothing here runs `src/`, which is all it mutates.
pytestmark = pytest.mark.skipif(
    not (Path(__file__).parent.parent / "toolchain").is_dir(),
    reason="needs images/skills/toolchain/",
)

# Spellings ruff honours and near misses it ignores: whitespace, case, text after the command, `#`-separated parts.
_COMMENTS = [
    "# fmt: off",
    "#fmt:off",
    "#  fmt:   off  ",
    "#\tfmt:\x0coff",
    "# fmt: off is forbidden by our style guide",
    "# fmt: off # noqa",
    "# noqa # fmt: off",
    "## fmt: off",
    "# FMT: off",
    "# fmt : off",
    "# fmt: Off",
    "# fmt: off\u00a0",
    "# \u00a0fmt: off",
    "# fmt: offline",
    "# fmt: on",
    "#fmt:on",
    "# fmt: on, now",
    "## fmt: on",
    "# fmt: skip",
    "# fmt:skip",
    "#fmt: skip",
    "# fmt:   skip ",
    "# fmt: skip?",
    "# fmt: skip, why",
    "# fmt: skip; noqa",
    "# fmt: skips",
    "# fmt: Skip",
    "# fmt: skip # noqa: E231",
    "# noqa: E231 # fmt: skip",
    "# noqa: E231 #fmt:skip",
    "## fmt: skip",
    "# x fmt: skip",
    "# yapf: disable",
    "#yapf:disable",
    "# yapf: disable # why",
    "# yapf: disabled",
    "# yapf: enable",
    "# yapf:enable",
    "# yapf: enabled",
]


@pytest.fixture(scope="module")
def rule() -> ModuleType:
    spec = importlib.util.spec_from_file_location(
        "cogmo_toolchain_suppressions_under_test", _TOOLCHAIN / ".cogmo/suppressions.py"
    )
    assert spec is not None
    assert spec.loader is not None
    module = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(module)
    return module


def _formatted(source: str) -> str:
    return subprocess.run(
        [str(_RUFF), "format", "--config", str(_TOOLCHAIN / "pyproject.toml"), "-"],
        input=source,
        capture_output=True,
        text=True,
        check=True,
    ).stdout


def _refuses_line(rule: ModuleType, source: str, line: int) -> bool:
    return any(refusal.line == line for refusal in rule.scan(source).refusals)


@pytest.mark.parametrize("comment", _COMMENTS)
def test_a_comment_on_its_own_line_is_refused_where_the_formatter_honours_it(rule: ModuleType, comment: str) -> None:
    # Honoured as `off`, the layout after it is kept; as `on`, it ends a region `# fmt: off` began.
    off = "y = [1,2]" in _formatted(f"{comment}\ny = [1,2]\n")
    on = "z = [1, 2]" in _formatted(f"# fmt: off\nx = [1,2]\n{comment}\nz = [1,2]\n")

    assert _refuses_line(rule, f"{comment}\ny = 1\n", 1) == (off or on)


@pytest.mark.parametrize("comment", _COMMENTS)
def test_a_comment_ending_a_statement_is_refused_where_the_formatter_honours_it(rule: ModuleType, comment: str) -> None:
    kept = "y = [1,2]" in _formatted(f"y = [1,2]  {comment}\n")

    assert _refuses_line(rule, f"y = 1  {comment}\n", 1) == kept


@pytest.mark.parametrize("comment", ["# fmt: off", "# fmt: skip", "# yapf: disable"])
def test_a_comment_between_brackets_is_no_pragma(rule: ModuleType, comment: str) -> None:
    own_line = f"x = [\n    {comment}\n    1,2,\n]\n"
    ending = f"x = [\n    [1,2],  {comment}\n    3,\n]\n"

    assert "1,2," not in _formatted(own_line)
    assert "[1,2]" not in _formatted(ending)
    assert rule.scan(own_line).refusals == []
    assert rule.scan(ending).refusals == []
