Register's CPython checks and the skills repo's `.cogmo/verify` gain formatting and unused-suppression checks, and the Imports rule moves into the toolchain (design/skills.md → Register-time CPython checks).

- **Formatting.** Register and verify run `ruff format --check` at the version `uv.lock` pins, so the layout reviewers read is the formatter's. Formatter pragmas (`# fmt: off`, `# fmt: on`, `# fmt: skip`, `# yapf: disable`, `# yapf: enable`) are refused wherever `ruff format` honours them.
- **Unused suppressions.** ruff's `RUF100` and `RUF102` and pyrefly's `unused-ignore` make a suppression that suppresses nothing, or names a rule ruff does not know, a finding.
- **Imports.** The rule is the toolchain's `.cogmo/imports.py`, which register's runner loads as it loads the suppression rule.
- **Guidance.** The generated toolchain `CLAUDE.md` lists verify's checks in order and says a skill directory holds no `__init__.py`, and `test_skill.py` imports the skill as `from skill import run`.
