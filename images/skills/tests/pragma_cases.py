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

# Each pragma on `SKILL`, and whether the suppression rule refuses it.
PRAGMAS: dict[str, tuple[str, bool]] = {
    "noqa-coded": (SKILL.replace("return text.upper()", "return text.upper()  # noqa: E501"), False),
    "ruff-ignore": (SKILL.replace("def shout", "# ruff: ignore[E501]\ndef shout"), False),
    "pyrefly-coded": (
        SKILL.replace("return text.upper()", "return text.upper()  # pyrefly: ignore[bad-return]"),
        False,
    ),
    "noqa-bare": (SKILL.replace("return text.upper()", "return text.upper()  # noqa"), True),
    "ruff-noqa": (f"# ruff: noqa\n{SKILL}", True),
    "ruff-noqa-coded": (f"{SKILL}# ruff: noqa: E501\n", True),
    "ruff-disable": (f"# ruff: disable[E501]\n{SKILL}", True),
    "pyrefly-bare": (SKILL.replace("return text.upper()", "return text.upper()  # pyrefly: ignore"), True),
    "pyrefly-file": (f"# pyrefly: ignore-errors\n{SKILL}", True),
}


REFUSED = frozenset(name for name, (_, refused) in PRAGMAS.items() if refused)
