Register now runs a container-tier skill's `test_skill.py` with `pytest` before deploying it.

- **The session.** The suite runs in a skills-image session of its own, created last in register's checks. It has no network interface, mounts the skill's dependencies when it has any, takes the larger of the default and the skill's own memory and CPU, and caps the whole suite at 60 s.
- **What refuses the tip.** A failed test, a collection error, a suite that reports no test, a JUnit report over the size bound, or a run past the cap refuses the tip, with the failing tests as findings. A finding's text is masked for secrets. Because the pre-submit runs register's checks, those findings reach the coding agent as a fix pass.
- **What pauses the register.** A missing dependency venv, pytest's usage error (exit 4), or an unusable session pauses the register instead.
- **When the suite doesn't run:**
  - with no sandbox backend;
  - on a backend that can't create a no-network session, such as Daytona;
  - for a skill with dependencies but no shared venv volume;
  - for a skill with no `test_skill.py`;
  - when the tip already equals `main`, so a flaky suite can't stall a repeat;
  - when the skills image predates the test runner;
  - for wasm-tier skills, which are held until the Docker proxy's ownership slice lets the session run without the Docker socket.
- **The record.** Each deploy records the outcome on its classifier log as `tests`: `passed` with the test count, or `not_run` with the reason. Older deploys read `null`.
- **Size.** The size gate bounds `test_skill.py` too.
