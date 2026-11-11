A coding task on the skills repo now dry-runs register on its pushed commit before the PR opens, and records the verdict (design/coding-delegation.md → Skills-repo pre-submit).

- After the verify run pushes, Cogmo fetches the pushed commit and runs register's own checks on it (`SkillRunner.checkRegister`): the gates, the classifier, the path rules, Imports, the lockfile check and the CPython checks. It writes no deploy state.
- The verdict (`passed`, `refused` with register's findings, `stale_base`, or `unavailable` when a check cannot run) is stored on the task as `presubmit_verdict`. Nothing acts on it yet: every verdict proceeds to the PR as before, so the verdicts measure how often register would refuse.
- Register's rejections now say which are terminal and which only pause the work, and the lockfile check reports the compile's error kind.
