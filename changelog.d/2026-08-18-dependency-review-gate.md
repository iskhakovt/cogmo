A PR that introduces a vulnerable production dependency now fails a check, which is the layer the scheduled audit deliberately isn't.

Auditing the whole tree on `pull_request` was rejected for the scheduled job because a fresh advisory in any transitive dependency would block every unrelated PR until someone fixed it — a merge-gate change affecting all future work. `dependency-review-action` doesn't have that shape: it diffs the base ref against the head ref and fails only on what the PR itself adds, so the gate stays proportional to the change under review.

`fail-on-scopes: runtime` mirrors the scheduled job's `--prod` — what ships is what blocks, and a dev-only advisory is worth knowing about without stopping unrelated work. `fail-on-severity: moderate` keeps the gate credible; low-severity findings on a newly added package are usually noise, and a gate that cries wolf gets routed around. Licence checking stays off: that is a separate policy this repo hasn't taken, and it shouldn't arrive as a side effect of adding a security gate.

Two details that make it work here rather than in principle. It reads GitHub's dependency graph rather than the lockfile, and that graph does cover this workspace — the repo's SBOM resolves about 1200 packages from `pnpm-lock.yaml`. And the graph is computed asynchronously after a push, so a freshly opened PR can be reviewed before its snapshot exists; the action retries on that warning instead of failing on something that resolves itself.

No PR comment, deliberately. That needs `pull-requests: write`, which a `pull_request` run from a fork is not granted, so it would convert an outside contribution into a workflow failure. The job summary carries the same detail.

With this, the three layers are complete: Dependabot's `npm-security` group opens PRs for advisories it can fix, this blocks a PR that adds one, and the weekly audit catches advisories that appear against code nobody touched.
