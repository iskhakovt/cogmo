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
- For non-trivial PRs, drop a longer-form fragment under [`changelog.d/`](changelog.d/) — file `YYYY-MM-DD-NN-short-slug.md`, plain Markdown body, rich rationale/side-effects/test counts welcome. One fragment per PR; never edit existing fragments.

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

Wrong format = no release. The PR title check (`amannn/action-semantic-pull-request`) blocks merge if the title doesn't parse.

## What CI runs

`.github/workflows/ci.yml` on every PR and push to `main`:

| Job | What |
|-|-|
| **PR Title** | Validates Conventional Commits format (PRs only) |
| **Typecheck & Lint** | `pnpm typecheck && pnpm lint` |
| **Unit Tests** | `pnpm test` (PGlite, mocked LLM) + Codecov upload |
| **Integration Tests** | `pnpm test:integration` against testcontainers + llmock fixtures |
| **E2E Tests** | Builds Docker image, runs `pnpm test:e2e` against it |
| **Release** | `semantic-release` (push to `main` only, after all jobs pass) |

## Release process

Releases are fully automated. There is no manual version bump.

1. Merge a PR with a `feat:` or `fix:` title (or include `BREAKING CHANGE:` for a major).
2. The `release` job runs `semantic-release` on `main`:
   - Reads commit history since the last tag.
   - Computes the next version from commit types.
   - Generates release notes.
   - Creates a GitHub release and a `vX.Y.Z` git tag.
3. The tag triggers `.github/workflows/publish.yml`:
   - Derives the version from the tag (Dunamai).
   - Builds the Docker image (cache hit from CI).
   - Pushes to `ghcr.io/<owner>/cogmo:<version>`.

`chore:`/`docs:`/`refactor:`/etc. commits land in `main` without cutting a release. The next `feat:` or `fix:` will pick them up in the release notes.

If a release needs to be skipped for some reason, append `[skip release]` to the commit footer (semantic-release honours it).

## Code style

See [CLAUDE.md](CLAUDE.md) for the full style guide. The short version: idiomatic TypeScript, `function` declarations for named exports, ESM with `.js` extensions, `Result<T, E>` at boundaries, dependency injection over hard imports, strict encapsulation with `#private` fields, no dead code.
