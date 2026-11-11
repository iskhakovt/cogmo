"""The suppressions a skill may carry, read from its comments by `.cogmo/verify` and by Cogmo's register alike.

A suppression names its rule and covers one line: ruff's `# noqa: <code>` and `# ruff: ignore[<code>]`, and pyrefly's
`# pyrefly: ignore[<error>]`. A pragma that covers more is refused: ruff's `# ruff: noqa` and `# flake8: noqa` with
or without codes, `# ruff: file-ignore[...]` and `# ruff: disable[...]`, and pyrefly's `# pyrefly: ignore-errors`;
so is pyrefly's bare `# pyrefly: ignore`, which names no error. ruff's own PGH004 refuses a bare `# noqa`, and the
configuration has pyrefly honor only its own pragmas, so `# type: ignore` suppresses nothing. The formatter's pragmas
(`# fmt: off`, `# fmt: on`, `# fmt: skip`, `# yapf: disable`, `# yapf: enable`) are refused wherever `ruff format`
honours them, and recorded as no suppression, since a skill's layout is the formatter's; a comment the formatter
ignores is no pragma. A file carries at most `MAX_SUPPRESSIONS`.

Part of Cogmo's toolchain, which Cogmo replaces on each release.
"""

import io
import re
import tokenize
from typing import Literal, NamedTuple

MAX_SUPPRESSIONS = 100

# Each pragma as its tool reads it from a comment's `#`: ruff's names are case-sensitive and `noqa` is not; pyrefly's
# names and its colon admit no space between them.
_FILE_NOQA = re.compile(r"#\s*(ruff|flake8)\s*:\s*[Nn][Oo][Qq][Aa]")
_RUFF_BLOCK = re.compile(r"#\s*ruff\s*:\s*(file-ignore|disable)\s*\[")
_RUFF_IGNORE = re.compile(r"#\s*ruff\s*:\s*ignore\s*\[([^\]]*)\]")
_NOQA = re.compile(r"#\s*[Nn][Oo][Qq][Aa]")
_NOQA_CODES = re.compile(r"\s*:(.*)", re.DOTALL)
_PYREFLY_FILE = re.compile(r"#\s*pyrefly:\s*ignore-errors")
_PYREFLY = re.compile(r"#\s*pyrefly:\s*ignore(.*)", re.DOTALL)

# The formatter's pragmas as the pinned ruff's formatter reads a comment (`SuppressionKind::from_comment` in
# `ruff_python_trivia`): past one `#`, and Python's whitespace at either end, the comment is `fmt:` or `yapf:` and,
# after whitespace, exactly a command; or one of its `#`-separated parts, so trimmed, is `fmt:` and exactly `skip`.
# Case counts, and Python's whitespace is space, tab and form feed alone. Each command's kind is `off`, `on` or `skip`.
_PYTHON_WHITESPACE = " \t\x0c"
type _FormatterKind = Literal["off", "on", "skip"]
_FORMATTER_COMMANDS: dict[str, dict[str, _FormatterKind]] = {
    "fmt:": {"off": "off", "on": "on", "skip": "skip"},
    "yapf:": {"disable": "off", "enable": "on"},
}
# A comment between brackets belongs to an expression, where the formatter reads no pragma.
_OPENING = frozenset("([{")
_CLOSING = frozenset(")]}")

# The codes a rule can have; another names no rule, so suppresses nothing and is not recorded.
_RUFF_CODE = re.compile(r"[A-Z]+[0-9]+")
_PYREFLY_CODE = re.compile(r"[a-z][a-z0-9-]*")
_MAX_CODE = 64

_RUFF_PER_LINE = "suppress per line, naming the rule: `# noqa: <code>`"
_PYREFLY_PER_LINE = "suppress per line, naming the error: `# pyrefly: ignore[<error>]`"


class Suppression(NamedTuple):
    """A suppression the rule accepts: its tool, one rule it names, and its comment's 1-based line."""

    tool: str
    code: str
    line: int


class Refusal(NamedTuple):
    """A pragma the rule refuses, at its `#`: a 1-based line and code point column."""

    line: int
    column: int
    message: str


class Scan(NamedTuple):
    suppressions: list[Suppression]
    refusals: list[Refusal]


class _FormatterPragma(NamedTuple):
    """A formatter pragma in a comment: its `#`'s code point offset in the comment, its kind, and its directive."""

    offset: int
    kind: _FormatterKind
    directive: str


def scan(source: str) -> Scan:
    """Every suppression and refused pragma in `source`'s comments, in order.

    Raises `SyntaxError` or `tokenize.TokenError` when `source` cannot be tokenized.
    """
    suppressions: list[tuple[Suppression, int]] = []
    refusals: list[Refusal] = []
    lines = io.StringIO(source, newline=None).read().split("\n")
    depth = 0
    for token in tokenize.generate_tokens(io.StringIO(source, newline=None).readline):
        if token.type == tokenize.OP and token.string in _OPENING:
            depth += 1
        elif token.type == tokenize.OP and token.string in _CLOSING:
            depth -= 1
        if token.type != tokenize.COMMENT:
            continue
        line, start = token.start
        pragma = _formatter_pragma(token.string)
        own_line = lines[line - 1][:start].strip(_PYTHON_WHITESPACE) == ""
        if pragma is not None and depth == 0 and _formatter_honours(pragma.kind, own_line):
            refusals.append(
                Refusal(
                    line,
                    start + pragma.offset + 1,
                    f"`# {pragma.directive}` exempts code from `ruff format`, whose layout every skill keeps",
                )
            )
        noqa_seen = False
        for offset, comment in _comments(token.string):
            column = start + offset + 1
            refused = _refusal(comment)
            if refused is not None:
                refusals.append(Refusal(line, column, refused))
                continue
            codes: list[tuple[str, str]] = []
            if not noqa_seen and (noqa := _NOQA.match(comment)):
                # ruff reads a comment's first `noqa` alone.
                noqa_seen = True
                codes = [("ruff", code) for code in _noqa_codes(comment, noqa.end())]
            elif matched := _RUFF_IGNORE.match(comment):
                codes = [("ruff", code.strip()) for code in matched.group(1).split(",")]
            elif matched := _PYREFLY.match(comment):
                codes = [("pyrefly", code) for code in _pyrefly_codes(matched.group(1))]
            suppressions.extend(
                (Suppression(tool, code, line), column) for tool, code in codes if _names_a_rule(tool, code)
            )
    if len(suppressions) > MAX_SUPPRESSIONS:
        extra, column = suppressions[MAX_SUPPRESSIONS]
        refusals.append(
            Refusal(extra.line, column, f"more than {MAX_SUPPRESSIONS} suppressions; fix what they suppress instead")
        )
    refusals.sort()
    return Scan([s for s, _ in suppressions[:MAX_SUPPRESSIONS]], refusals)


def _comments(text: str) -> list[tuple[int, str]]:
    """A comment token's comments, each from a `#` to the next, with its code point offset in the token."""
    starts = [i for i, c in enumerate(text) if c == "#"]
    return [(start, text[start:end]) for start, end in zip(starts, [*starts[1:], len(text)], strict=True)]


def _refusal(comment: str) -> str | None:
    if matched := _FILE_NOQA.match(comment):
        return f"`# {matched.group(1)}: noqa` exempts the whole file; {_RUFF_PER_LINE}"
    if matched := _RUFF_BLOCK.match(comment):
        reach = "the whole file" if matched.group(1) == "file-ignore" else "the lines after it"
        return f"`# ruff: {matched.group(1)}` exempts {reach}; {_RUFF_PER_LINE}"
    if _PYREFLY_FILE.match(comment):
        return f"`# pyrefly: ignore-errors` exempts the whole file; {_PYREFLY_PER_LINE}"
    if (matched := _PYREFLY.match(comment)) and _pyrefly_blanket(matched.group(1)):
        return f"`# pyrefly: ignore` names no error; {_PYREFLY_PER_LINE}"
    return None


def _formatter_pragma(comment: str) -> _FormatterPragma | None:
    """The formatter pragma a comment token is or holds, as ruff's formatter reads it; None when it is none."""
    whole = comment.removeprefix("#").strip(_PYTHON_WHITESPACE)
    for prefix, commands in _FORMATTER_COMMANDS.items():
        command = whole.removeprefix(prefix).lstrip(_PYTHON_WHITESPACE)
        if whole.startswith(prefix) and command in commands:
            return _FormatterPragma(0, commands[command], f"{prefix} {command}")
    for offset, part in _comments(comment):
        rest = part.removeprefix("#").strip(_PYTHON_WHITESPACE)
        if rest.startswith("fmt:") and rest.removeprefix("fmt:").lstrip(_PYTHON_WHITESPACE) == "skip":
            return _FormatterPragma(offset, "skip", "fmt: skip")
    return None


def _formatter_honours(kind: _FormatterKind, own_line: bool) -> bool:
    """Whether the formatter acts on a pragma of `kind` outside brackets, where a comment belongs to a statement.

    `off` and `on` bound a region from their own line; `skip`, and `off` too, keep the layout of the statement whose
    line they end.
    """
    return kind == "off" or (kind == "on" and own_line) or (kind == "skip" and not own_line)


def _noqa_codes(comment: str, start: int) -> list[str]:
    """The codes of a `# noqa: <codes>` past `start`, read as ruff reads them: up to the first word that is not one."""
    matched = _NOQA_CODES.match(comment, start)
    if matched is None:
        return []
    codes: list[str] = []
    for word in re.split(r"[\s,]+", matched.group(1)):
        if not word:
            continue
        if not re.fullmatch(f"(?:{_RUFF_CODE.pattern})+", word):
            break
        codes.extend(_RUFF_CODE.findall(word))
    return codes


def _pyrefly_codes(rest: str) -> list[str]:
    """The errors a `# pyrefly: ignore[<errors>]` names, read as pyrefly reads them; none for another form."""
    rest = rest.lstrip()
    if not rest.startswith("["):
        return []
    return [code.strip() for code in rest[1:].split("]", 1)[0].split(",")]


def _pyrefly_blanket(rest: str) -> bool:
    """Whether what follows `# pyrefly: ignore` makes it pyrefly's blanket form, which suppresses every error."""
    if rest.lstrip().startswith("["):
        return False
    return not rest or rest[0].isspace() or not (rest[0].isalnum() or rest[0] in "-_")


def _names_a_rule(tool: str, code: str) -> bool:
    shape = _RUFF_CODE if tool == "ruff" else _PYREFLY_CODE
    return len(code) <= _MAX_CODE and shape.fullmatch(code) is not None
