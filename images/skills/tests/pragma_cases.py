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
    # The formatter's pragmas, which `ruff format` honours: the layout is the formatter's.
    "fmt-off": (f"# fmt: off\n{SKILL}", True),
    "fmt-on": (SKILL.replace("def shout", "# fmt: on\ndef shout"), True),
    "fmt-skip": (SKILL.replace("return text.upper()", "return text.upper()  # fmt: skip"), True),
    "yapf-disable": (f"# yapf: disable\n{SKILL}", True),
    "yapf-enable": (SKILL.replace("def shout", "# yapf: enable\ndef shout"), True),
}

REFUSED = frozenset(name for name, (_, refused) in PRAGMAS.items() if refused)
