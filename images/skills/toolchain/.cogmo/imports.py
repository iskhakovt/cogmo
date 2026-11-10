"""The imports a skill may carry, checked by `.cogmo/verify` and by Cogmo's register alike.

An import is allowed when its first segment is in the standard library or is `pydantic`, `pydantic_core` or
`cogmo_ctx`, which the runtime installs for every task, or when a declared dependency installs it. Which distributions
install a module comes from the `RECORD` of each distribution in the lockfile's environment, read from that
environment's own site-packages, never from an interpreter's path: a module only a transitive dependency installs is
refused, since a skill declares what it imports. Nothing here imports or runs the skill's code or its dependencies'.

Part of Cogmo's toolchain, which Cogmo replaces on each release.
"""

import ast
import importlib.machinery
import importlib.metadata
import re
import sys
from collections.abc import Iterable, Mapping, Sequence
from pathlib import PurePosixPath
from typing import NamedTuple

# What a skill imports besides the stdlib and its own dependencies: the runtime the image installs for every task.
RUNTIME_ROOTS = frozenset({"pydantic", "pydantic_core", "cogmo_ctx"})

# Lines end where CPython, ruff and pyrefly all end them.
_NEWLINE = re.compile(r"\r\n|\r|\n")

# A dependency's name: the whole of a PEP 503 name, or the name of a `name==version` pin (`SkillDependencySchema`).
_DEPENDENCY_NAME = re.compile(r"^([A-Za-z0-9](?:[A-Za-z0-9._-]*[A-Za-z0-9])?)")


class Refusal(NamedTuple):
    """An import the rule refuses, at its statement: a 1-based line and code point column."""

    line: int
    column: int
    message: str


def installed_modules(site_packages: str) -> dict[str, frozenset[str]]:
    """Each distribution in `site_packages` with the modules its `RECORD` lists, by its PEP 503 name."""
    return {
        _normalized(name): record_modules(dist.files or [])
        for dist in importlib.metadata.distributions(path=[site_packages])
        if (name := dist.metadata.get("Name"))
    }


def record_modules(files: Iterable[PurePosixPath]) -> frozenset[str]:
    """The modules a `RECORD`'s paths list.

    Each path names the module its file is: a `.py` file, or one with an extension module's suffix, without the
    suffix, and an `__init__` its directory. So a directory whose `__init__` no `RECORD` lists (PEP 420) is a namespace
    and names no module. Other files (`py.typed`, a license, a `.pth`), `*.dist-info/`, `*.data/`, `__pycache__/`,
    paths leaving site-packages, and names that are not identifiers name none.
    """
    return frozenset(module for path in files if (module := _record_module(PurePosixPath(path).parts)) is not None)


def _record_module(parts: tuple[str, ...]) -> str | None:
    if not parts or parts[0] in ("..", "/") or parts[0].endswith((".dist-info", ".data")) or "__pycache__" in parts:
        return None
    module = _module_name(parts[-1])
    if module is None:
        return None
    segments = parts[:-1] if module == "__init__" else (*parts[:-1], module)
    return ".".join(segments) if segments and all(segment.isidentifier() for segment in segments) else None


def _module_name(file: str) -> str | None:
    if file.endswith(".py"):
        return file.removesuffix(".py")
    suffix = next((s for s in importlib.machinery.EXTENSION_SUFFIXES if file.endswith(s)), None)
    return None if suffix is None else file.removesuffix(suffix)


def _normalized(name: str) -> str:
    return re.sub(r"[-_.]+", "-", name).lower()


def _dependency_name(spec: str) -> str:
    matched = _DEPENDENCY_NAME.match(spec)
    return _normalized(matched.group(1) if matched else spec)


def scan(source: str, dependencies: Sequence[str], installed: Mapping[str, frozenset[str]]) -> list[Refusal]:
    """Every import in `source` the stdlib, the runtime and the modules a declared dependency installs do not cover.

    `dependencies` are the declared ones, as `name==version` pins or bare names; `installed` maps each distribution
    in the lockfile's environment to its modules (`installed_modules`). `import a.b` imports `a.b`. `from a.b import c`
    reads `c` from `a.b`, so it passes when a declared distribution's `RECORD` alone lists `a.b`'s file; from a
    namespace it imports `a.b.c`. The distributions that install a module are those installing its deepest prefix that
    some distribution installs, or, for a namespace, every one installing a module beneath it.

    Raises `SyntaxError`, `RecursionError` or `MemoryError` when `source` does not parse.
    """
    tree = ast.parse(source, "skill.py")
    lines = _NEWLINE.split(source)
    declared = frozenset(_dependency_name(spec) for spec in dependencies)
    installers: dict[str, set[str]] = {}
    for name, modules in installed.items():
        for module in modules:
            installers.setdefault(module, set()).add(name)
    refusals: list[Refusal] = []
    for node in ast.walk(tree):
        if isinstance(node, ast.Import):
            imported = [alias.name for alias in node.names]
        elif isinstance(node, ast.ImportFrom):
            if node.level > 0:
                refusals.append(_at(node, lines, "a relative import, which a skill's one module cannot resolve"))
                continue
            module = node.module or ""
            if _sole_installer(module, installers) in declared:
                continue
            imported = [module if alias.name == "*" else f"{module}.{alias.name}" for alias in node.names]
        else:
            continue
        messages = (_import_refusal(name, declared, installers) for name in imported)
        refusals.extend(_at(node, lines, message) for message in dict.fromkeys(m for m in messages if m is not None))
    return sorted(refusals, key=lambda r: (r.line, r.column))


def _import_refusal(name: str, declared: frozenset[str], installers: Mapping[str, set[str]]) -> str | None:
    root = name.split(".")[0]
    if root in sys.stdlib_module_names or root in RUNTIME_ROOTS:
        return None
    installed = _installed_as(name, installers)
    if installed is None:
        return (
            f"'{root}' is not the standard library, pydantic, pydantic_core, cogmo_ctx or a module a declared "
            "dependency installs"
        )
    module, names = installed
    if names & declared:
        return None
    return (
        f"'{module}' is installed by {', '.join(f"'{n}'" for n in sorted(names))}, which no declared dependency "
        "names; declare every package the skill imports"
    )


def _sole_installer(module: str, installers: Mapping[str, set[str]]) -> str | None:
    """The one distribution whose `RECORD` lists `module`'s file, its `__init__` or module; None for none or several."""
    names = installers.get(module, set())
    return next(iter(names)) if len(names) == 1 else None


def _installed_as(name: str, installers: Mapping[str, set[str]]) -> tuple[str, set[str]] | None:
    """The module `name` imports as installed, with the distributions installing it; None when none installs it."""
    parts = name.split(".")
    for depth in range(len(parts), 0, -1):
        prefix = ".".join(parts[:depth])
        if prefix in installers:
            return prefix, installers[prefix]
    beneath = {n for module, names in installers.items() if module.startswith(f"{name}.") for n in names}
    return (name, beneath) if beneath else None


def _at(node: ast.stmt, lines: Sequence[str], message: str) -> Refusal:
    """A refusal at `node`, whose `col_offset` counts UTF-8 bytes, as a code point column."""
    text = lines[node.lineno - 1] if 1 <= node.lineno <= len(lines) else ""
    prefix = text.encode("utf-8")[: max(node.col_offset, 0)].decode("utf-8", errors="ignore")
    return Refusal(node.lineno, len(prefix) + 1, message)
