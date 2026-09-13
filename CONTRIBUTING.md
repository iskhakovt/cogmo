# Contributing

This is a private personal project, but the conventions below apply to anyone (human or agent) touching the repo.

## Where things live

| If you need... | Look at |
|-|-|
| How to run the app locally | [README.md](README.md) |
| Architecture, code style, module boundaries | [CLAUDE.md](CLAUDE.md) |
| Design intent for a subsystem | [`design/`](design/) |
| What's queued / in progress | [todo.md](todo.md), [PROGRESS.md](PROGRESS.md) |
| What changed and when | [`changelog.d/`](changelog.d/) (one Markdown fragment per PR) |
| Running in production | [DEPLOYMENT.md](DEPLOYMENT.md) |

## Local workflow

Before pushing, run:

```bash
pnpm typecheck && pnpm lint && pnpm test
```

For changes that affect prompts, tools, or LLM/embedding requests, also re-record fixtures and run integration tests:

```bash
pnpm test:record
pnpm test:integration
```

CI is strict — unmatched LLM requests fail the build.

## Branching & PRs

- Branch from `main`. One logical change per branch.
- Open a PR against `main`. CI must be green before merge.
- Keep PRs reviewable — split mechanical refactors from behavioural changes when practical.
- The PR title is what ends up in the auto-generated GitHub release notes (semantic-release reads it), so it must follow Conventional Commits — see below.
- For non-trivial PRs, drop a longer-form fragment under [`changelog.d/`](changelog.d/) — file `YYYY-MM-DD-short-slug.md` (slug specific enough to disambiguate from parallel same-day PRs), plain Markdown body, rich rationale/side-effects/test counts welcome. One fragment per PR; never edit existing fragments.

## Conventional Commits

All commit messages **and PR titles** follow [Conventional Commits](https://www.conventionalcommits.org/):

```
type(scope): description

[optional body]

[optional footer]
```

**Type** drives the release:

| Type | Version bump | Use for |
|-|-|-|
| `fix` | patch | Bug fixes |
| `feat` | minor | New user-visible behaviour |
| `feat!` or `BREAKING CHANGE:` footer | major | Anything that breaks an existing contract |
| `perf` | patch | Performance improvements |
| `refactor`, `test`, `docs`, `chore`, `ci`, `build` | none | Internal changes, no release cut |

**Scope** is optional but encouraged when the change is localised: `feat(transport): add Slack adapter`, `fix(memory): handle empty recall result`. Use the module name from `src/` as the scope.

**Description** is imperative, lowercase, no trailing period: `add X`, not `Added X.` or `Adds X`.

Examples:

```
feat(agent): stream tool_use blocks to transport
fix(transport): preserve message order across debounce window
refactor(memory): extract Hindsight client into provider interface
chore: bump drizzle-orm to 0.46
```

Wrong format = no release. The PR title check runs commitlint (the `pr-title` job in `.github/workflows/ci.yml`, configured by `commitlint.config.js`) and blocks merge if the title doesn't parse.

## What CI runs

`.github/workflows/ci.yml` on every PR and push to `main`:

| Job | What |
|-|-|
| **PR Title** | Validates Conventional Commits format (PRs only) |
| **Typecheck & Lint** | `pnpm typecheck && pnpm lint` |
| **Unit Tests** | `pnpm test` (PGlite, mocked LLM) + Codecov upload |
| **Integration Tests** | `pnpm test:integration` against testcontainers + llmock fixtures |
| **E2E Tests** | Builds Docker image, runs `pnpm test:e2e` against it |

## Release process

Releases are cut on demand, not on every merge. The version is never bumped by hand: semantic-release computes it from the Conventional Commit titles merged since the last tag (the `conventionalcommits` preset, so a `!` after the type or scope marks a breaking change as well as a `BREAKING CHANGE:` footer).

1. Merge PRs with Conventional Commit titles. A breaking change needs `!` (`feat(infra)!: …`) or a `BREAKING CHANGE:` footer to produce a major.
2. Dispatch `.github/workflows/release.yml` from `main` — Actions → Release → Run workflow, or `gh workflow run release.yml --ref main`. The run:
   - Waits for every check on `main` HEAD to be green (the `skip_ci_check` input bypasses this when an external check is stuck).
   - Pauses for approval on the `production` environment.
   - Runs `semantic-release`: reads commits since the last tag, computes the next version, generates release notes, and creates the GitHub release and `vX.Y.Z` tag.
3. If a release was published, the same run calls `.github/workflows/publish.yml`:
   - Derives the version from the tag at HEAD (Dunamai).
   - Builds the images.
   - Pushes `ghcr.io/<owner>/cogmo:<version>` and its variants.

`chore:`/`docs:`/`refactor:`/etc. commits land in `main` without producing a version on their own. The next release that includes a `feat:` or `fix:` picks them up.

There is no per-commit opt-out: a release includes every commit since the last tag. To leave a change out, revert it before dispatching the release.

## Code style

See [CLAUDE.md](CLAUDE.md) for the full style guide. The short version: idiomatic TypeScript, `function` declarations for named exports, ESM with `.js` extensions, `Result<T, E>` at boundaries, dependency injection over hard imports, strict encapsulation with `#private` fields, no dead code.
