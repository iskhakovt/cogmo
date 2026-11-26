# CI

What the GitHub Actions setup must guarantee, how GitHub evaluates the merge gate, and the layout that meets both. The workflows live in `.github/workflows/`; [CONTRIBUTING.md](../CONTRIBUTING.md) → What CI runs summarizes the jobs.

## Requirements `[proposed]`

| # | Requirement | Today |
|-|-|-|
| R1 | **One required check.** `Required Checks` aggregates every CI job, so a job joins the gate through `needs:`, never through a ruleset edit. | Met |
| R2 | **Fail closed.** A job that errors, is cancelled, or is skipped outside an allowed case fails the gate. A broken path filter fails the run; it never skips it. | Met: alls-green, and `changes` is not an allowed skip |
| R3 | **A CI run is a full evaluation of its commit.** The gate reads only the newest CI run (Gate semantics), so the CI workflow can't hold a run that tests less than the suite. | Met, by running the full suite on every event |
| R4 | **No duplicate runs.** A CI run starts only for a push, an open or a reopen. An E2E request reruns the newest run instead of starting one. | Not met: each label starts a full run, so a Dependabot PR runs CI two or three times |
| R5 | **Doc-only PRs pass in about a minute.** | Met: `changes` path filter |
| R6 | **E2E** runs on every push to `main`. On a PR that changes code it runs on request, without a new commit, and a requested E2E that fails blocks the merge. | Met: the `e2e` label |
| R7 | **Release only from a green `main` HEAD.** | Met: `release.yml` waits up to 5 min for every non-Codecov check on HEAD; `skip_ci_check` overrides |
| R8 | **Deterministic and secret-free.** PR CI makes no live provider calls and needs no secret beyond optional Docker Hub pull auth, so Dependabot and fork PRs pass. | Met: record/replay fixtures ([testing.md](testing.md)) |
| R9 | **Supply chain.** Actions pinned to SHAs, `permissions: {}` by default, workflow linting, dependency review, CodeQL, the weekly audit, the 7-day release-age soak. | Met except workflow linting: no actionlint or zizmor |
| R10 | **Flakes are explained, not retried** (`.agents/rules/testing.md`). A failure on code that also passed is surfaced and tracked. | Partly: nothing retries, but a flake is noticed only by whoever reruns it |
| R11 | **Gate latency** under 10 min at p90. | Not met: median 8.7 min, p90 12.3 min |

Open: Sysbox E2E runs path-filtered on PRs but sits outside the gate, so its failure doesn't block a merge. Either it joins R1 or it stays advisory by decision.

## Gate semantics `[confirmed]`

Observed on this repo in November 2026; GitHub's documentation doesn't state these rules (Best practice → Several runs on one commit).

- **The required check.** The `main` ruleset requires one check, `Required Checks`, from GitHub Actions.
- **Which run counts.** GitHub reads that check from the newest run of the CI workflow on the PR's head SHA.
  - Older CI runs are ignored. #840 stayed blocked with every check green, because a label-triggered CI run newer than the full run reported no `Required Checks`.
  - Runs of other workflows neither satisfy nor block it. #822, #831, #833 and #834 were mergeable with a CodeQL or Dependency Review run newest.
- **When the check exists.** A run creates `Required Checks` only once every job it needs has finished; #837 and #838 had none mid-run. Until then the gate is pending.
- **Skips and reruns.** A job skipped by its `if:` reports success. A rerun adds an attempt to the same run, and the newest attempt is the run's result.

Consequences:
- **Full run or none.** An event either starts a full CI run or starts none. A cheaper CI run either reports `Required Checks` before the full run finishes, which makes the PR mergeable mid-test, or reports none, which blocks it.
- **No dispatch.** CI takes no `workflow_dispatch`. A dispatched run on a PR branch would become the newest CI run, and PR Title and Schema ⇒ design doc are allowed skips outside `pull_request`, so it could pass the gate without them.
- **Older runs only show.** A failure in an older run on the same SHA shows red in the PR's checks without blocking the merge.

## Today `[confirmed]`

| Workflow | Runs on | In the gate | Does |
|-|-|-|-|
| CI (`ci.yml`) | PR opened, synchronize, reopened, labeled; push to `main` | Yes, as `Required Checks` | Change detection, PR title, schema ⇒ design doc, typecheck + lint + knip, connector contract, hadolint, skills runtime (Python), unit, web, integration; E2E on `main` and on the `e2e` label |
| Sysbox E2E | PR and push to `main`, path-filtered; dispatch | No | The supervisor's sysbox tests on a sysbox-installed runner |
| CodeQL | PR to `main`, push to `main`, weekly | No | Static analysis |
| Dependency Review | PR | No | Flags vulnerable new dependencies |
| Dependency Audit | Weekly, dispatch | n/a | `pnpm audit --prod`, opening or updating an issue on findings |
| Release | Dispatch | n/a | semantic-release from a green `main` HEAD, then Publish |
| Publish | Called by Release, dispatch | n/a | The multi-arch app image and the devbase and skills images to GHCR, Trivy scan |
| GHCR Cleanup | Weekly, dispatch | n/a | Prunes old image versions |

Measured on the 150 PRs merged between 2026-10-21 and 2026-11-26, and on `main`'s last 100 commits:

- **Volume.** 4.2 PRs merge a day, 27% of them Dependabot's.
- **Runs per merged head.** 1.05 for agent PRs, 2.24 for Dependabot's. Dependabot adds `dependencies` and an ecosystem label to every PR, and `labels: []` doesn't stop it.
- **Latency.** The gate takes a median 8.7 min and 12.3 min at p90, from run start to `Required Checks`.
  - Unit Tests is the critical path: median 8.4 min, p90 11.7.
  - Integration takes 3.5 min, web 0.8, and typecheck + lint + knip 0.7.
- **Concurrency.** A code PR starts 13 CI jobs (14 with E2E), plus CodeQL's 3, Dependency Review's 1 and, on matching paths, Sysbox's 1. That is up to 19 against the account's 20 concurrent jobs on the Free plan, shared by parallel agent PRs.
- **E2E on request.** 6 merged PRs in 36 days.
- **Flakes.** 2 of the 31 heads with several runs had runs that disagreed on identical code (#669 E2E, #779 Unit Tests). #823 and #826 (2026-11-24) did the same, and reruns hid it.
- **`main`.** One failed push run in 100 commits (#748, Unit Tests).
- **Hardening.** `permissions: {}` with per-job grants and SHA-pinned actions. No workflow linter and no Actions lockfile.

## Best practice `[research]`

Researched November 2026; sources under References.

- **Shape.** Well-run TypeScript monorepos keep one CI workflow: a change-detection job, path filtering inside the workflow, and an aggregator job as the one required check. Vitest, Vite and Astro all do this. Security linting and publishing live in workflows of their own. Biome runs about 28 workflows split by area, which works for an organization with a merge queue.
- **Path filters.** A workflow skipped by `on.paths` leaves its required check pending and blocks the merge, so required workflows filter inside the workflow. A job skipped by `if:` reports success, so the aggregator has to list its allowed skips.
- **Merge queue.** Available only to organization-owned public repos, or to organization repos on Enterprise Cloud. Under a queue, checks report on `merge_group` as well as `pull_request`, and the queue is where expensive suites usually run.
- **Several runs on one commit.** No official tie-break rule exists. A GitHub Support reply quoted in community discussion #77942 says status checks "look up the status of the latest run". GitHub also advises unique job names across workflows.
- **On-demand jobs.** A `labeled` trigger starts a full new run for every label, Dependabot's included. A rerun through the API stays in the same run, re-runs dependent jobs (the aggregator among them), keeps the original actor's privileges, and is limited to 50 reruns within 30 days. ChatOps (`issue_comment`) runs on the default branch with a write token and needs its SHA pinned, or it is open to time-of-check/time-of-use attacks.
- **Shared setup.** A composite action, which Vitest uses, removes duplicated setup without changing check names. A reusable workflow reports as `<caller> / <job>`.
- **Speed.**
  - Vitest shards by file (`--shard`, the `blob` reporter, `--merge-reports`), which pays when test time dwarfs the roughly one minute of setup per job.
  - The Free plan runs 20 concurrent jobs per account (Pro: 40), and jobs beyond that queue.
  - The Actions cache is 10 GB per repo, so caches should be written from `main`.
  - "Affected only" runs follow the import graph, which misses fixtures, migrations, Dockerfiles and Python.
- **Flakes.** GitHub has no flake tracking. Codecov Test Analytics reads JUnit and flags tests that both fail and pass. Auto-retrying jobs is widely treated as hiding bugs.
- **Hardening.**
  - zizmor audits workflows for template injection, excessive permissions, and credentials persisted by `actions/checkout`.
  - Workflow lockfiles (`actions.lock`, GA 2026-10-28 on every plan) pin what composite actions pull in.
- **Dependabot.** `labels: []` is documented to disable labels and doesn't (dependabot-core#11783, open since 2025-03).

## Target layout `[proposed]`

Keep the shape: one `ci.yml`, path filtering inside it, one aggregator. It is the established layout, and on a user-owned repo with no merge queue it is the one that meets R1–R3. Change what misses a requirement:

1. **Labels start no CI run; E2E is requested by rerun (R3, R4, R6).**
   - **Triggers.** `ci.yml` runs on `opened`, `synchronize`, `reopened` and push to `main`. Its concurrency group keeps a group of its own for `reopened` only.
   - **Live labels.** `changes` reads the PR's labels from the API, and fails when the read fails (R2). E2E's condition and the label-removal step both read that output, not the event payload, which a rerun keeps.
   - **`e2e-request.yml`** runs on `labeled`; for the `e2e` label it:
     - targets the newest `pull_request` CI run, by run ID, for the PR's current head SHA. If there is none, or the head has moved on, it does nothing, because the new push's run reads the label itself;
     - waits for that run to finish, and never cancels it, since a cancel is asynchronous and races the rerun. If that run already ran E2E, it stops;
     - reruns every job if the run passed. If it failed, it reruns nothing and fails, so the failure gets investigated, not rerun away (R10).
   - **Other labels,** Dependabot's included, run that workflow's skipped job and nothing in CI.
   - **Residuals.**
     - A failed request (an API error, the 50-rerun limit, a fork PR's read-only token) shows red but can't block the merge, so the PR can merge without the E2E it asked for. The owner sees the red request.
     - A rerun keeps the original actor's token, so on a Dependabot PR the label-removal step can't write, and it is skipped there.
2. **Shared setup.** `.github/actions/setup` (pnpm, Node, `pnpm install --frozen-lockfile`) replaces the steps CI's six Node jobs, `sysbox-e2e.yml` and `dependency-audit.yml` repeat.
3. **Sharded unit tests (R11).**
   - **Shards.** Unit Tests runs as three shards with the `blob` reporter, covering both unit projects. Each shard is in the aggregator's `needs:`, so a failed shard fails the gate.
   - **Merge job.** A merge job (`if: always()`) merges the blobs into one JUnit report and, on `main`, one coverage report. It fails when a shard's blob is missing.
   - **Job budget.** The three hadolint matrix jobs fold into one, so the shards and their merge job add one job net: 14 for a code PR.
   - **Related todo.** The unit-tier speedup entry in `todo.md` (Pyodide bootstrap) cuts the work itself; sharding spreads it.
4. **Workflow linting (R9).** A `workflows` job, gated on `.github/**` changes, runs actionlint and zizmor. Checkouts zizmor flags set `persist-credentials: false`. `actions.lock` follows once `gh actions-lock` reaches 1.0.
5. **Flake visibility (R10).** Every unit and integration JUnit report goes to Codecov Test Analytics, failed attempts included. A flagged test gets a todo entry and a root cause; nothing retries.
6. **Sysbox E2E in the gate (open).**
   - It becomes a CI job behind a `changes` output computed from today's paths, with `ci.yml` in place of its own workflow file, on PRs and on `main` alike. It is listed in `allowed-skips`.
   - Manual runs move to a dispatch-only workflow, because CI takes no dispatch (Gate semantics).
7. **Dependabot.** The `labels: []` entries go.

## Not adopted `[proposed]`

- **Merge queue.** It needs an organization-owned repo. Moving cogmo to an organization changes the GHCR image path and the deploy pins. At 4.2 merges a day, with `main` green on 99 of 100 commits, the push run on `main` and the release gate cover post-merge breakage.
- **Separate required workflows.** Each needs its own required check, and a path-filtered workflow leaves its check pending.
- **CI as reusable workflows.** No other workflow shares CI's jobs. Publish already is one, called by Release.
- **Retries,** of jobs or tests. They hide flakes (R10).
- **ChatOps `/e2e`.** It runs on the default branch with a write token. A label plus a rerun does the same without the time-of-check/time-of-use risk.
- **Affected-only runs.** The import graph misses cassettes, migrations, Dockerfiles and Python.
- **Dependabot auto-merge.** Every merge needs the owner's approval.

## Rollout `[proposed]`

One PR per slice, each verified on its own runs:

1. **Labels out of CI** (layout items 1 and 7). This supersedes #840.
   - First confirm that `GITHUB_TOKEN` with `actions: write` may rerun a run. If it can't, an E2E request takes two steps: add the label, then "Re-run all jobs" on the newest CI run.
   - Verify on the PR:
     - a throwaway label starts no CI run and leaves the PR mergeable;
     - `e2e` reruns CI with E2E and gates the merge;
     - `e2e` added mid-run waits, then reruns;
     - `e2e` on a failed run reruns nothing.
2. **Composite setup** (2). A pure refactor; check names don't change.
3. **Unit shards** (3). Measure gate latency over a week of PRs against R11.
4. **Workflow linting** (4), after fixing what zizmor reports on today's workflows.
5. **Flake visibility** (5), after confirming uploads work from Dependabot PRs, which get no repository secrets.
6. **Sysbox in the gate** (6), if decided.

## References

- Merge queue availability: [GA changelog](https://github.blog/changelog/2023-07-12-pull-request-merge-queue-is-now-generally-available/), [merging with a merge queue](https://docs.github.com/en/pull-requests/how-tos/merge-and-close-pull-requests/merging-a-pull-request-with-a-merge-queue)
- Required checks: [troubleshooting](https://docs.github.com/en/pull-requests/how-tos/merge-and-close-pull-requests/troubleshooting-required-status-checks), [about protected branches](https://docs.github.com/en/repositories/configuring-branches-and-merges-in-your-repository/managing-protected-branches/about-protected-branches), [community #77942](https://github.com/orgs/community/discussions/77942)
- Reruns: [re-running workflows and jobs](https://docs.github.com/en/actions/how-tos/manage-workflow-runs/re-run-workflows-and-jobs)
- Limits: [Actions limits](https://docs.github.com/en/actions/reference/limits)
- Layouts: [Vitest CI](https://github.com/vitest-dev/vitest/blob/main/.github/workflows/ci.yml), [Vite CI](https://github.com/vitejs/vite/blob/main/.github/workflows/ci.yml), [Astro CI](https://github.com/withastro/astro/blob/main/.github/workflows/ci.yml), [alls-green](https://github.com/re-actors/alls-green)
- Sharding: [Vitest performance](https://vitest.dev/guide/improving-performance)
- Flakes: [Codecov Test Analytics](https://docs.codecov.com/docs/test-analytics)
- Hardening: [zizmor audits](https://docs.zizmor.sh/audits/), [workflow lockfiles GA](https://github.blog/changelog/2026-10-28-github-actions-workflow-lockfiles-are-generally-available)
- Dependabot labels: [dependabot-core#11783](https://github.com/dependabot/dependabot-core/issues/11783)
