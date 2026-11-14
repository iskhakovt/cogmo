Register runs the verify stage's CPython checks in a sandbox session before its transaction (design/skills.md → Verify stage → Register-time CPython checks).

- **The tools.** The skills image carries a tools virtualenv, `/opt/cogmo-skills/tools`, built from the skills repo toolchain's lock (about 83 MB), and a copy of the toolchain. Register's ruff and pyrefly read the same configuration as the author's `.cogmo/verify`.
- **The checks.** One check session runs five checks over `skill.py`, reporting in the gates' `errors` format with UTF-16 columns:
  - CPython's `compile`;
  - ruff;
  - pyrefly against the typed `cogmo_ctx`;
  - Imports, which refuses a module that no declared dependency's wheel installs, a module only a transitive dependency installs included. A namespace package shared by several distributions, such as `google/`, counts per module beneath it. A name a `from` import reads out of a package one declared distribution alone installs passes, even when it is a submodule only a transitive dependency installs;
  - Suppressions: a pragma must name its rule and cover one line (`# noqa: <code>`, `# ruff: ignore[<code>]`, `# pyrefly: ignore[<error>]`). File-wide and blanket forms are refused, and so are more than 100 suppressions in a file. `.cogmo/verify` applies the same rule from the toolchain's `.cogmo/suppressions.py`, and the toolchain's ruff and pyrefly settings refuse a bare `# noqa` and ignore `# type: ignore`.
- **The reply** carries the first 100 findings, each message cut to 400 characters, then a count of the rest per check, so a flood of findings rejects instead of overflowing the host's read.
- **Dependencies.** The install session populates the lockfile's venv first, for either tier. A sync that uv refuses for the lockfile's content rejects as `requirements_lock_uninstallable`; any other failure pauses as `registrar_unavailable: sandbox`.
- **A check that cannot run** pauses register as `registrar_unavailable: sandbox`.
- **No backend configured.** Register skips the checks with a warning.
- **The record.** The classifier log records the `toolchain_version` that judged the deploy and every suppression the checks accepted.
- **The CLI.** `cogmo skills register` and `approve` get a sandbox client of their own, without serve's reconcile, reaper or image warm. So a CLI register runs the lockfile compile and the checks as serve's does.
