A coding task on the skills repo now dry-runs register on its pushed commit before the PR opens, and records the verdict (design/coding-delegation.md → Skills-repo pre-submit).

- After the verify run pushes, Cogmo fetches the pushed commit and runs every check register makes before its deploy on it (`SkillRunner.checkRegister`). It writes no deploy state.
- The verdict (`passed`, `refused` with register's findings, `stale_base`, or `unavailable` when a check cannot run, so refusals and pauses stay apart) is stored on the task as `presubmit_verdict`. Nothing acts on it yet: every verdict proceeds to the PR as before, so the verdicts measure how often register would refuse.
