"""The pragmas the suppression rule's two callers are held to, one table for both.

`test_toolchain_verify.py` asserts `.cogmo/verify` fails exactly the `REFUSED` cases and `test_check.py` that
register's checks find something in exactly those, so a branch that passes verify passes register.
"""

SKILL = """\
from pydantic import BaseModel

from cogmo_ctx import Ctx


class Input(BaseModel):
    text: str


class Output(BaseModel):
    text: str


def shout(text: str) -> str:
    return text.upper()


async def run(inputs: Input, ctx: Ctx) -> Output:
    return Output(text=shout(inputs.text))
"""

# A line ruff (S105) and one pyrefly (bad-assignment) report, for an accepted suppression to cover: one that
# suppresses nothing is itself a finding (RUF100, pyrefly's `unused-ignore`).
_RUFF_FINDING = 'PASSWORD = "hunter2"'
_PYREFLY_FINDING = 'COUNT: int = "none"'


def _before_input(line: str) -> str:
    return SKILL.replace("\n\n\nclass Input", f"\n\n{line}\n\n\nclass Input", 1)


def _own_line(comment: str) -> str:
    """`SKILL` with `comment` on its own line, at statement level."""
    return SKILL.replace("def shout", f"{comment}\ndef shout", 1)


def _trailing(comment: str) -> str:
    """`SKILL` with `comment` at the end of a statement's line."""
    return SKILL.replace("return text.upper()", f"return text.upper()  {comment}", 1)


def _in_brackets(comment: str, own_line: bool) -> str:
    """`SKILL` with `comment` inside a list's brackets, on its own line or after an element."""
    element = f"    {comment}\n    1,\n" if own_line else f"    1,  {comment}\n"
    return _before_input(f"NUMBERS = [\n{element}]")


# Each pragma on `SKILL`, and whether the suppression rule refuses it.
PRAGMAS: dict[str, tuple[str, bool]] = {
    "noqa-coded": (_before_input(f"{_RUFF_FINDING}  # noqa: S105"), False),
    "ruff-ignore": (_before_input(f"# ruff: ignore[S105]\n{_RUFF_FINDING}"), False),
    "pyrefly-coded": (_before_input(f"{_PYREFLY_FINDING}  # pyrefly: ignore[bad-assignment]"), False),
    "noqa-bare": (SKILL.replace("return text.upper()", "return text.upper()  # noqa"), True),
    "ruff-noqa": (f"# ruff: noqa\n{SKILL}", True),
    "ruff-noqa-coded": (f"{SKILL}\n\n# ruff: noqa: E501\n", True),
    "ruff-disable": (f"# ruff: disable[E501]\n{SKILL}", True),
    "pyrefly-bare": (SKILL.replace("return text.upper()", "return text.upper()  # pyrefly: ignore"), True),
    "pyrefly-file": (f"# pyrefly: ignore-errors\n{SKILL}", True),
    # The formatter's pragmas, where `ruff format` honours them: the layout is the formatter's. `off` and `on` on their
    # own line, `skip`, `off` and `disable` at the end of a statement's line.
    "fmt-off": (f"# fmt: off\n{SKILL}", True),
    "fmt-off-unspaced": (f"# fmt:off\n{SKILL}", True),
    "fmt-off-trailing": (_trailing("# fmt: off"), True),
    "fmt-on": (_own_line("# fmt: on"), True),
    "fmt-skip": (_trailing("# fmt: skip"), True),
    "fmt-skip-unspaced": (_trailing("# fmt:skip"), True),
    "fmt-skip-padded": (_trailing("# fmt:   skip"), True),
    "fmt-skip-segment": (_trailing("# keeps its layout # fmt: skip"), True),
    "fmt-skip-first-segment": (_trailing("# fmt: skip # keeps its layout"), True),
    "yapf-disable": (f"# yapf: disable\n{SKILL}", True),
    "yapf-disable-trailing": (_trailing("# yapf: disable"), True),
    "yapf-enable": (_own_line("# yapf: enable"), True),
    # Comments ruff's formatter ignores: text after the command, another case, a space before the colon, a
    # whitespace Python does not count, `off` or `on` as a later segment, a command where it is not honoured.
    "fmt-off-with-text": (_own_line("# fmt: off is forbidden by our style guide"), False),
    "fmt-off-later-segment": (_own_line("# see below # fmt: off"), False),
    "fmt-off-double-hash": (_own_line("## fmt: off"), False),
    "fmt-off-uppercase": (_own_line("# FMT: off"), False),
    "fmt-off-spaced-colon": (_own_line("# fmt : off"), False),
    "fmt-off-nbsp": (_own_line("# \u00a0fmt: off"), False),
    "fmt-offline": (_own_line("# fmt: offline"), False),
    "fmt-skip-question": (_trailing("# fmt: skip?"), False),
    "fmt-skip-with-text": (_trailing("# fmt: skip, why"), False),
    "fmt-skip-capitalized": (_trailing("# fmt: Skip"), False),
    "fmt-skip-own-line": (_own_line("# fmt: skip"), False),
    "fmt-on-trailing": (_trailing("# fmt: on"), False),
    "yapf-enable-trailing": (_trailing("# yapf: enable"), False),
    "yapf-disabled": (_own_line("# yapf: disabled"), False),
    "fmt-off-in-brackets": (_in_brackets("# fmt: off", own_line=True), False),
    "fmt-skip-in-brackets": (_in_brackets("# fmt: skip", own_line=False), False),
}

REFUSED = frozenset(name for name, (_, refused) in PRAGMAS.items() if refused)
