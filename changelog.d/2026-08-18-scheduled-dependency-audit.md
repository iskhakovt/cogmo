A weekly workflow runs `pnpm audit --prod` and tracks the outcome in a single labelled issue: it opens or comments on that issue while advisories exist, and closes it on the first clean run. An open issue therefore means the production tree has an advisory now, not that one was seen once.

It exists because nothing else re-checks. `overrides:` is empty, so no floor is enforced by construction, and Dependabot's `npm-security` group only opens PRs for advisories it can fix by bumping — one with no patched version, or whose fix needs a decision, is otherwise invisible. `@grpc/grpc-js` shows the exposure: it resolves to exactly 1.14.4, the same version an override used to pin, so a parent narrowing its range re-resolves under a critical advisory with nothing to notice.

Scheduled rather than gating, deliberately. Auditing the whole tree on `pull_request` blocks every PR on advisories that have nothing to do with it; gating a PR on what it *introduces* is a different mechanism and lives in `dependency-review.yml`.

`--prod` scopes it to what ships. The verdict comes from `--json`, not the exit code: pnpm exits 1 for advisories, for an unreachable registry and for a bad flag alike, so keying on non-zero would announce advisories whenever the command merely failed. A successful run carries `metadata.vulnerabilities` and a failed one doesn't, so output that is unparseable or missing that field fails the workflow instead of being reported as a finding. pnpm's own table is rendered for the issue body by a second run, taken only when there is something to show.

The report reaches the issue body through an environment variable rather than shell interpolation.
