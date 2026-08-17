---
description: Runs a workspace-wide dependency sweep — bumping packages, majors, toolchain pins and base images — with the behavioural-diff and verification steps that a green build does not cover. Use when bumping dependencies, taking a major, refreshing pins, or acting on a batch of Dependabot PRs.
when_to_use: "Trigger phrases: bump the deps, dependency sweep, update everything, take the majors, refresh the pins, we haven't touched this repo in a while, handle the Dependabot PRs."
argument-hint: "[scope, e.g. 'minors only' or 'everything including majors']"
---

# Dependency sweep

A sweep's real risk is not a build that breaks. It is a dependency that changes
behaviour while `tsc` and the whole test suite stay green. Budget most of the
effort for finding those, because nothing in the toolchain will point at them.

## Order of work

One commit per group, verified before the next goes in, so a bisect lands on a
single group:

1. Patch + minor on `1.x` and above.
2. `0.x` minors — semver gives no protection here; treat each as a major.
3. Majors, one at a time.
4. Toolchain pins, base images, GitHub Actions, devcontainer images.
5. Vendored artefacts no dependency tool watches. `apps/server/data/litellm-models.json`
   is the known one: nothing reports it stale, and a missing model silently
   falls back to `DEFAULT_LIMITS` (128k context, 4096 output) with only a
   deduplicated WARN.

## For every major: diff the behaviour, not just the types

`pnpm outdated -r` and a green suite tell you nothing about this. For each
major, read the upstream CHANGELOG or migration guide looking specifically for
**behaviour that moved under an unchanged signature**, then grep our call sites
for it. Things this has actually caught:

- A provider stopped sending a request field but kept requiring it in the
  response schema, so calls were billed and then failed validation.
- A new enum member appeared upstream and fell through our `string`-typed
  mapper into the wrong branch. Retype such mappers to the SDK union with an
  exhaustiveness guard so the *next* addition is a compile error.
- A list method became a lazily-paged async iterator, so `.items` silently read
  only the first page.
- A duration helper started clamping sub-second values up to one second.
- A transport gained a read-buffer cap whose overflow closes the connection.
- A stdlib set moved inside the runtime bundle, changing what must be
  explicitly loaded.

## When behaviour matters, read the installed source

Do not infer semantics from an API surface or a README. Read
`node_modules/.pnpm/<pkg>@<version>/...` or trace the real thing. Every
expensive mistake in this repo's sweeps came from reasoning about a library
instead of reading it, and each was settled in minutes once actually checked:

- `p-retry` throws an `AbortError`'s `originalError` **before** consulting
  `shouldRetry`, so an `AbortError` subclass never reaches the caller as itself
  and a predicate paired with one never runs. Use `shouldRetry` alone whenever
  the caller must discriminate on error type.
- `git commit` spawns `git maintenance run --auto --detach`, which keeps writing
  into `.git/` after the command returns — visible only under `GIT_TRACE=1`.
- pnpm's `engineStrict` ignores dependency `engines` entirely and only warns
  about the current project's own.
- `ls-engines` collapses an `||`-gapped engine intersection to `>= <lowest>`,
  so it reports a range admitting an excluded major as an exact match.

## Advisories and overrides

`pnpm audit --prod` is the target, and a sweep is the moment to retire
`overrides:`. For each entry, delete it, re-resolve, and confirm the patched
range still arrives on its own — that is what the block's own comment
prescribes. Record the margin: an entry resolving to exactly the floor its
override enforced will regress the moment a parent narrows its range, because
an `overrides:` floor ratchets and a satisfied lockfile entry does not.

## Record/replay fixtures

Five mocks share `RECORD=1` (llmock, fal, openai-voice, xAI, daytona) and each
guards on its own upstream key, so only adapters with keys in `.env` re-record.
Re-record when prompt structure, tool sets, models, or an SDK's wire format
changed. Then **verify each cassette in replay mode**, the mode CI runs.

Two traps:

- `pnpm test:record -- <file>` silently ignores the file filter and re-records
  the entire integration tier against every live upstream. Scope a recording
  with `RECORD=1 pnpm exec vitest run --project integration <file>`.
- Fixture matching is `(method, path)` FIFO. A random per-test UUID appearing in
  a URL must be pinned to a fixed string, or replay will not match.

## Gates: what each one actually covers

| Command | Time | Covers |
|-|-|-|
| `pnpm lint` | ~2s | Biome across the workspace. Also enforced by the Stop hook. |
| `pnpm typecheck` | 30–37s | All three packages. Deliberately not in a hook — too slow per turn. |
| `pnpm test` | ~140s | Unit tier only. |
| `pnpm test:integration` | ~3min | Needs Docker. Run peers together, not one file alone. |

**None of the above builds the Docker image or bundles the web SPA.** That gap
has bitten: deleting a directory left a `COPY` in the root `Dockerfile`
pointing at nothing, and only the label-gated e2e job builds the image. After
any change to root files, `Dockerfile`, `.dockerignore`, or a workspace
manifest, either build the image locally or push with the `e2e` label and watch
it. The label is removed automatically once e2e goes green, so a later push
skips e2e by design rather than by accident.

On NixOS the browser-driven web tests need `nix develop` — Playwright's
prebuilt `chrome-headless-shell` is missing 22 shared libraries otherwise.

## Every new guard must be verified failing

A canary that has only ever been observed passing is not a guard. Break the
thing it watches and confirm it goes red, then restore. This repo has shipped
an engines check that silently skipped 40% of its inputs, a test double that
asserted a contract the library does not offer, and an integration test that
could not fail on the wire shape it existed to pin — all green throughout.

Prefer pinning the failing direction as a permanent test over a one-off manual
check, so it stays verified.

## Landing it

- One changelog fragment in `changelog.d/`, present tense, describing what the
  code *is*. No review-round narrative, no intermediate states that never
  shipped — the commits own that history.
- Before requesting review, re-read the full diff and refresh the PR title and
  body. On a long sweep both drift: a title naming "two defects" after a dozen
  landed, a test count from twenty commits ago.
- Type the PR so semantic-release does the right thing. Squash-merge feeds the
  PR title to the analyser, so `chore` on a sweep carrying behavioural fixes
  ships them without cutting a release.
