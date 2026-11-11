"""`toolchain/.cogmo/imports.py`, the Imports rule register's checks apply.

Register's use of it is `test_check.py`'s; this file holds what that does not reach as directly: how a `RECORD` names
modules, and how distributions are keyed.
"""

import importlib.machinery
import importlib.util
import os
from pathlib import Path, PurePosixPath
from types import ModuleType

import pytest

from .distributions import install

_RULE = Path(__file__).parent.parent / "toolchain" / ".cogmo" / "imports.py"

# The mutation image has no toolchain/, and nothing here runs `src/`, which is all it mutates.
pytestmark = pytest.mark.skipif(
    not (Path(__file__).parent.parent / "toolchain").is_dir(),
    reason="needs images/skills/toolchain/",
)


@pytest.fixture(scope="module")
def rule() -> ModuleType:
    spec = importlib.util.spec_from_file_location("cogmo_toolchain_imports_under_test", _RULE)
    assert spec is not None
    assert spec.loader is not None
    module = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(module)
    return module


def test_record_paths_map_to_the_modules_they_install(rule: ModuleType) -> None:
    suffix = next(s for s in importlib.machinery.EXTENSION_SUFFIXES if s != ".so")
    files = [
        "pkg/__init__.py",
        "pkg/sub/mod.py",
        "pkg/inner/__init__.py",
        "single.py",
        f"_native{suffix}",
        "_plain.so",
        "namespace/part/__init__.py",
        "namespace/nested/leaf.py",
        "pkg.libs/libvendored-1a2b.so",
        "py.typed",
        "LICENSE",
        "pkg-1.0.pth",
        "pkg-1.0.dist-info/METADATA",
        "pkg-1.0.data/scripts/tool.py",
        "__pycache__/single.cpython-314.pyc",
        "pkg/__pycache__/mod.cpython-314.pyc",
        "../../../bin/tool",
        "/etc/absolute",
    ]

    modules = rule.record_modules(PurePosixPath(f) for f in files)

    assert modules == frozenset(
        {
            "pkg",
            "pkg.sub.mod",
            "pkg.inner",
            "single",
            "_native",
            "_plain",
            "namespace.part",
            "namespace.nested.leaf",
        }
    )


def test_installed_distributions_are_keyed_by_their_pep_503_name(rule: ModuleType, tmp_path: Path) -> None:
    site_packages = tmp_path / "site-packages"
    install(site_packages, "My.Pkg_Name", {"my_pkg/__init__.py": "", "../../../bin/my-pkg": ""})
    no_record = site_packages / "bare-1.0.dist-info"
    no_record.mkdir()
    (no_record / "METADATA").write_text("Metadata-Version: 2.1\nName: Bare\nVersion: 1.0\n")

    installed = rule.installed_modules(os.fspath(site_packages))

    assert installed == {"my-pkg-name": frozenset({"my_pkg"}), "bare": frozenset()}


@pytest.mark.parametrize("dependency", ["My.Pkg_Name==1.0", "my-pkg-name"])
def test_a_dependency_is_declared_by_its_pin_or_its_normalized_name(rule: ModuleType, dependency: str) -> None:
    # Register passes the manifest's pins; a bare name declares the distribution its normalized form names.
    installed = {"my-pkg-name": frozenset({"my_pkg"})}

    assert rule.scan("import my_pkg\n", [dependency], installed) == []
    assert rule.scan("import my_pkg\n", [], installed) == [
        (
            1,
            1,
            "'my_pkg' is installed by 'my-pkg-name', which no declared dependency names; "
            "declare every package the skill imports",
        )
    ]


def test_a_refusal_after_non_ascii_text_is_at_its_code_point_column(rule: ModuleType) -> None:
    # `import` is the 11th code point; `ast` puts it at byte offset 14.
    assert rule.scan('s = "é😀"; import yaml\n', [], {}) == [
        (
            1,
            11,
            "'yaml' is not the standard library, pydantic, pydantic_core, cogmo_ctx or a module a declared "
            "dependency installs",
        )
    ]


def test_a_source_that_does_not_parse_raises(rule: ModuleType) -> None:
    with pytest.raises(SyntaxError):
        rule.scan("import (\n", [], {})
