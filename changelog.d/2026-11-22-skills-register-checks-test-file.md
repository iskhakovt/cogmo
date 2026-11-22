Register's CPython checks now judge a skill's `test_skill.py` as well as its `skill.py`.

- **What runs over both files:** syntax, ruff, `ruff format --check`, pyrefly, the suppression rule and Imports.
- **Imports:** in the test file, Imports also allows `pytest`, `pytest_asyncio` and `skill`.
- **pyrefly** resolves `from skill import run`.
- **Suppressions:** the rule is enforced in each file, but only `skill.py`'s accepted suppressions are recorded on the deploy.
- **Findings** name their file (`skills/<name>/test_skill.py:<line>: …`). An older skills image's findings read as `skill.py`'s.
- **`CLAUDE.md`:** the skills repo's generated `CLAUDE.md` gains a `test_skill.py` section: its size bound, the imports it may use, and the 60 s no-network suite.

Since the pre-submit runs register's checks, a lint, type or format finding in the test file now reaches the coding agent as a fix pass too.
