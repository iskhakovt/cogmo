Register now runs a container-tier skill's `test_skill.py` with `pytest` before deploying it.

- **The session.** It runs in a skills-image session of its own: created last in register's checks, with no network interface, the skill's dependencies mounted when it has any, the larger of the default and the skill's own memory and CPU, and a 60 s cap on the whole suite.
- **Refusals.** A failed test, a collection error, a suite that reports no test or a run past the cap refuses the tip with the failing tests as findings. Because the pre-submit runs register's checks, those findings reach the coding agent as a fix pass.
- **Pauses.** A missing dependency venv, an unusable session or an image without the test runner pause the register instead.
- **When the suite doesn't run:**
  - on Daytona, which can't create a no-network session;
  - for a skill with no `test_skill.py`;
  - when the tip already equals `main`, so a flaky suite can't stall a repeat;
  - for wasm-tier skills, held until the Docker proxy's ownership slice lets the session run without the Docker socket.
- **The record.** Each deploy records the outcome on its classifier log as `tests`: `passed` with the test count, or `not_run` with its reason. Older deploys read `null`.
- **Size.** The size gate bounds `test_skill.py` too.
