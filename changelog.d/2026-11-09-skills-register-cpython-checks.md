Register runs the verify stage's CPython checks in a sandbox session before its transaction (design/skills.md → Verify stage → Register-time CPython checks).

- **The tools.** The skills image carries a tools virtualenv, `/opt/cogmo-skills/tools`, built from the skills repo toolchain's lock (about 83 MB), and a copy of the toolchain. Register's ruff and pyrefly read the same configuration as the author's `.cogmo/verify`.
- **The checks.** One check session runs four checks over `skill.py`, reporting in the gates' `errors` format with UTF-16 columns:
  - CPython's `compile`;
  - ruff;
  - pyrefly against the typed `cogmo_ctx`;
  - Imports, which refuses an import root that no declared dependency's wheel installs, a module only a transitive dependency installs included.
- **Dependencies.** The install session populates the lockfile's venv first, for either tier. A sync that uv refuses for the lockfile's content rejects as `requirements_lock_uninstallable`; any other failure pauses as `registrar_unavailable: sandbox`.
- **A check that cannot run** pauses register as `registrar_unavailable: sandbox`.
- **No backend configured.** Register skips the checks with a warning.
- **The recorded version.** The classifier log records the `toolchain_version` that judged the deploy.
- **The CLI.** `cogmo skills register` and `approve` get a sandbox client of their own, without serve's reconcile, reaper or image warm. So a CLI register runs the lockfile compile and the checks as serve's does.
