# Sub-agent briefs

Constraints to include in every sub-agent prompt. Each one exists because its
absence cost real work in this repo.

## Always state these

- **Verify the path before writing.** "Only edit files you have Read first, and
  confirm the path you write matches the path you intended." An agent generating
  content for one module once wrote it over a different module's file, taking it
  from 875 lines to 176. Nothing in the tooling catches that; the instruction
  does.
- **Report a verdict before a fix.** "Establish whether the premise holds before
  changing anything. If it does not, change nothing and report the evidence."
  Roughly one finding in five does not survive contact with the code, and an
  agent told only to fix will fix something that was never broken.
- **Red before green.** "Add a regression test, and state explicitly that you
  confirmed it fails before your change and passes after." The single strongest
  predictor of a sub-agent's work landing without rework.
- **Name the gates, and their limits.** Give the exact commands to run — usually
  `pnpm typecheck && pnpm lint` plus the specific test files touched — and say
  which suites *not* to run.
- **Hands off shared bookkeeping.** "Do not touch git. Do not edit `todo.md`,
  `PROGRESS.md`, or `changelog.d/`." Parallel agents each editing the changelog
  produces conflicts; the orchestrator owns those files.

## Concurrency

- **Do not run the full suite while agents are working.** The unit tier is ~140s
  of heavy parallelism; several agents plus a full run drives load into the tens
  and produces `Hook timed out in 30000ms` failures in PGlite tests that pass
  fine in isolation. Tell each agent to run only the files it touched, and save
  the full run for after they report.
- **Give each agent a disjoint file set.** Where that is impossible, run them
  sequentially or with `isolation: "worktree"`.
- **Never read an artefact an agent is still writing.** A grep that raced a
  fixture write once produced a confident and wrong "the fix didn't work".
  Wait for the completion notification.

## Reading their reports

A sub-agent's conclusion is evidence, not a verdict. Check the load-bearing
claim yourself before acting on it — especially one that contradicts something
already shipped. In this repo an agent's report has been right about a mechanism
and wrong about its consequence, and an unverified claim repeated from a review
put a wrong number in a changelog.
