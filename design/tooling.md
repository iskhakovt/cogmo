# Tooling

TypeScript on Node.js across a pnpm workspace: the long-running backend (`apps/server`), the web UI SPA (`apps/web`), and the contracts they share (`packages/contracts`).

## Core Stack

| Layer | Tool | Why |
|-|-|-|
| Runtime | Node.js LTS | Stable for a 24/7 process. Every runtime dependency and the OTel preload (`--import ./dist/otel.js`) target Node — see Runtime below |
| Package manager | pnpm | Fastest installs, strict deps, content-addressable store |
| Dev runner | tsx (watch mode) | Runs TS directly via esbuild, sub-second reloads, zero config |
| Build | tsup | esbuild-powered production builds, zero config |
| Type check | tsc --noEmit | Separate from build — run in CI and as watch process |
| HTTP | `node:http` + oRPC + sirv | No framework: the UI server routes on raw `node:http`, serves the admin API through oRPC's node handler and the SPA through sirv — see [web-ui.md](web-ui.md) |
| Validation | Zod v4 | 14x faster than v3, 78+ integrating libraries, ecosystem standard |
| ORM | Drizzle | SQL-like query chains, TS-native schema, tiny (5KB) |
| Migrations | drizzle-kit | Schema diffs → SQL files, comes with Drizzle |
| Testing | Vitest | 10-20x faster than Jest, native TS/ESM, same API |
| Logging | Pino | Structured JSON, 5x faster than Winston |
| Linter/formatter | Biome | Replaces ESLint + Prettier, 20x faster, one tool |
| Collections | Remeda + ES2025 | Kotlin-feel pipe chains, groupBy, lazy eval |
| Error handling | neverthrow | Result\<T, E\> without exceptions |
| CLI parsing | cmd-ts | Typed argument decoders, nested subcommands, generated help — see [decisions.md](decisions.md) |
| Orchestration | Inngest (self-hosted) | Event-driven durable execution — queues, scheduling, HITL, observability in one tool |

## Runtime

Node.js, on the `engines` floor in `apps/server/package.json`. Re-checked 2026-10 against the two alternatives:

- **Bun** — memory growth in long-running processes is still reported through 2026, and its Rust rewrite has not had a stable track record yet. Cogmo is one process running for weeks under a fixed memory cap, the workload that exposes it. Revisit after several stable releases with no long-run leak reports.
- **Deno** — runs most npm packages and ships OpenTelemetry built in, but offers cogmo nothing it lacks: Node 24 strips TypeScript types natively, isolation is the container sandbox rather than runtime permissions, and OTel already works through Node's module hooks. Moving would mean re-proving dockerode, pyodide's loader, the Inngest SDK, PGlite, testcontainers, Vitest and `pnpm deploy` for no gain. Revisit if in-process plugins need runtime-level permissions that Node's permission model can't give.

## Web UI

`apps/web` is a Vite-built React SPA, served by the backend. [web-ui.md](web-ui.md) owns the rationale and the planned additions; installed today:

| Layer | Tool |
|-|-|
| Build / dev server | Vite (proxies `/rpc` and `/api` to the backend in dev) |
| Framework | React 19, no SSR |
| Routing | TanStack Router |
| Chat | `@assistant-ui/react`, fed by `eventsource-client` over SSE |
| API client | oRPC client, typed from `webContract` in `packages/contracts` |
| Styling | Tailwind v4 (`@tailwindcss/vite`), IBM Plex via Fontsource |
| Command palette | cmdk |
| Testing | Vitest — Node for `.test.ts`, Browser Mode on Playwright Chromium for `.test.tsx` |

## Kotlin-Developer Patterns

### Collection Processing (Remeda)

```typescript
import { pipe, groupBy, mapValues, sortBy, filter } from 'remeda';

// Kotlin: users.filter { it.active }.groupBy { it.role }.mapValues { it.value.size }
pipe(
  users,
  filter(u => u.active),
  groupBy(u => u.role),
  mapValues(v => v.length),
);
```

ES2025 built-ins (Node 24): `Object.groupBy()`, `Map.groupBy()`, iterator helpers (`.map()`, `.filter()`, `.take()`, `.drop()`, `.flatMap()` on iterators — lazy sequences natively).

Use ES2025 where it suffices, Remeda for richer processing or pipe chains.

### Result Types (neverthrow)

```typescript
import { ok, err, Result, ResultAsync } from 'neverthrow';

function parseConfig(raw: string): Result<Config, ParseError> {
  // Returns Ok<Config> or Err<ParseError> — no exceptions
}

// Chain with .map, .andThen, .match
const result = parseConfig(input)
  .map(config => config.port)
  .match(
    port => startServer(port),
    error => console.error(error),
  );
```

### Branded Types (like Kotlin value classes)

```typescript
type Brand<K, T> = K & { readonly __brand: T };
type UserId = Brand<string, 'UserId'>;
type ConversationId = Brand<string, 'ConversationId'>;
// Can't accidentally pass UserId where ConversationId expected
```

## Drizzle (SQL-like, Kotlin Exposed/jOOQ equivalent)

```typescript
import { sql } from 'drizzle-orm';
import { pgTable, text, uuid, boolean, timestamp } from 'drizzle-orm/pg-core';

// Schema as TypeScript
export const steeringRules = pgTable('steering_rules', {
  id: uuid('id').primaryKey().default(sql`uuidv7()`),
  rule: text('rule').notNull(),
  category: text('category').notNull(),
  active: boolean('active').notNull(),
  createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
});

// Query — SQL-like chains with full autocompletion
const activeRules = await db
  .select()
  .from(steeringRules)
  .where(eq(steeringRules.active, true))
  .orderBy(steeringRules.createdAt);
```

drizzle-kit generates migration SQL from schema diffs (`pnpm db:generate`, then review the `.sql`). Boot and `cogmo seed` apply pending migrations through `src/db/migrate-per-file.ts`, one transaction per file.

## Utility Libraries

Small, focused libraries that fill gaps in the TS stdlib.

### Zero-Runtime (Types Only)

| Library | What | Stars |
|-|-|-|
| **type-fest** | 200+ utility types (`PartialDeep`, `Merge`, `JsonObject`, `Promisable`, etc.) | ~15k |
| **ts-reset** | Fixes TS stdlib holes — `JSON.parse` returns `unknown`, `.filter(Boolean)` narrows, `.includes()` works with `as const` | ~8k |

Install both, forget about them. Immediate DX improvement, zero runtime cost.

### Pattern Matching

```typescript
import { match, P } from 'ts-pattern';

// Exhaustive at compile time — miss a case, get a type error
const response = match(event)
  .with({ type: 'message' }, e => handleMessage(e))
  .with({ type: 'callback' }, e => handleCallback(e))
  .with({ type: 'command', command: P.string }, e => handleCommand(e))
  .exhaustive();
```

**ts-pattern** (~13k stars) — replaces sprawling if/else and switch. Exhaustiveness checking means the compiler catches missing cases.

### Async Primitives (p-* family by Sindre Sorhus)

**p-retry** — retry with backoff for transient failures: `pRetry(() => fetch(url), { retries: 3 })`. Reach for **p-limit** / **p-queue** from the same family when a call site needs a concurrency cap.

### Environment Parsing

```typescript
import { createEnv } from '@t3-oss/env-core';
import { z } from 'zod';

const env = createEnv({
  server: {
    ANTHROPIC_API_KEY: z.string().min(1),
    REDIS_PORT: z.coerce.number().default(6380),
  },
  runtimeEnv: process.env,
});
```

**@t3-oss/env-core** — type-safe `process.env` parsing with Zod. Coerces correctly, per-environment defaults.

### IDs, Dates, Serialization

| Library | What | When to use |
|-|-|-|
| **UUID v7** | Time-ordered unique IDs (native PostgreSQL 18, `uuidv7()`) | DB-generated, time-ordered, no dependency |
| **date-fns** | Modular date utilities | Until Node ships Temporal API natively |

## Not Needed

| Tool | Why not |
|-|-|
| Next.js / TanStack Start | SSR buys nothing for a single-user dashboard and fights the SSE + RPC model — a Vite SPA instead ([decisions.md](decisions.md)) |
| Fastify / Express / Hono | The UI server is a handful of routes plus the oRPC handler on raw `node:http`; a framework adds nothing |
| Jest | Vitest is faster with native TS/ESM |
| Winston | Pino is 5x faster, JSON-native |
| ESLint + Prettier | Biome does both, 20x faster |
| Lodash | Remeda is TS-first; ES2025 covers basics natively |
| tRPC | oRPC gives the same typed RPC plus native SSE and OpenAPI without a framework adapter ([decisions.md](decisions.md)) |
| cuid2 | UUID v7 is native in PostgreSQL 18 — no dependency needed |
| nanoid | UUID v7 covers all ID generation needs |
| BullMQ | Inngest handles all orchestration — queues, scheduling, durable execution |
| Effect-TS | Massive learning curve, overkill for solo project |
| fp-ts | Superseded by Effect; neverthrow covers Result types |
| Prisma | Heavier than Drizzle, custom DSL instead of TypeScript schema |
| Bun / Deno (runtime) | See Runtime above |

## Dev Workflow

```bash
pnpm install              # install deps
pnpm dev                  # dev infra in Docker, then the backend (tsx watch) and the Vite dev server
pnpm dev:app              # backend only: tsx watch src/main.ts serve
pnpm build                # backend: tsc && tsup → apps/server/dist
pnpm typecheck            # tsc in every workspace package
pnpm test                 # backend unit tier (Vitest); apps/web: pnpm --filter web test
pnpm lint                 # biome check, whole workspace
```

## Python sub-projects

The TypeScript host is the primary stack, but tier-2 skills run inside a python container and the runtime ships with that image as a real `cogmo_skills_runtime` package (`images/skills/`). Convention for any python that lives in the codebase:

- **uv** for dep management. `pyproject.toml` + `uv.lock`, `uv sync --locked` in CI and Dockerfiles. uv binary copied out of `ghcr.io/astral-sh/uv:<pinned>` in multi-stage Docker builds — no apt install of uv at runtime.
- **ruff** for lint + format. Single tool replaces flake8/black/isort. `select = ["F", "E", "W", "I", "B", "UP", "RUF"]` — tight at the small scale we run.
- **pyrefly** for typechecking — Meta's Rust typechecker, replaces Pyre. Picked over `mypy` (slower, weaker inference on partial annotations) and Astral's `ty` (still beta, ~53% spec conformance vs pyrefly's ~88% as of May 2026). Re-evaluate when `ty` hits 1.0 (Astral's track record on `ruff` / `uv` makes it the long-term favourite).
- **pytest** + `pytest-asyncio` (`asyncio_mode = "auto"`).
- src layout: `src/<package_name>/`, `tests/`, `py.typed` marker.
- Every python sub-project ships its CI in `.github/workflows/ci.yml` as a separate job that runs `uv sync --locked`, `ruff check`, `pyrefly check`, `pytest`.
- Multi-stage Dockerfile: builder syncs locked deps into a venv; runtime stage copies just the venv to `/opt/<name>/.venv` and adds it to `PATH`. `UV_NO_DEV=1`, `UV_NO_EDITABLE=1`, `UV_COMPILE_BYTECODE=1`. No build deps in the runtime stage.
