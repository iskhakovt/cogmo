---
description: Reviews a cogmo change for conformance to the repo's rules — idioms, architecture and DDD boundaries, state machines, Inngest replay safety, data, tests and bookkeeping — or a design doc against state-machines.md "Design before code". Runs the read-only cogmo-reviewer agent. Use before opening a PR, before approving a design, and when a sub-agent self-audits its diff.
when_to_use: "Trigger phrases: cogmo review, conformance review, check against the rules, review this design, is this ready for a PR."
argument-hint: "code <PR number | branch | diff range> | design <path>[ @ <ref>]"
context: fork
agent: cogmo-reviewer
background: false
---

Mode and target: `$ARGUMENTS`

- `code <target>` — run the `code` checklist against the PR, branch or diff
  range.
- `design <path>` — run the `design` checklist against that doc, read at the
  given ref (`@ <ref>`, e.g. `@ origin/docs/observer-by-turn`) or at `main`.

If the arguments name neither mode, or no target, stop and return the usage
line: `/cogmo-review code <PR | branch | range>` or
`/cogmo-review design <path>[ @ <ref>]`.

Follow your system prompt: load the rules, get the change at its ref, fill
the checklist, premise-check every finding, and return the report in the
output format. End the report with one line: "Conformance only — run
`/code-review` alongside for bugs."
