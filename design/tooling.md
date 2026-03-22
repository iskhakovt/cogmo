# Tooling

Modern TypeScript/Node.js stack for a long-running backend service. No frontend, no browser bundling.

## Core Stack

| Layer | Tool | Why |
|-|-|-|
| Runtime | Node.js LTS | Stable for 24/7 services. Bun still has memory leaks (Jan 2026). |
| Package manager | pnpm | Fastest installs, strict deps, content-addressable store |
| Dev runner | tsx (watch mode) | Runs TS directly via esbuild, sub-second reloads, zero config |
| Build | tsup | esbuild-powered production builds, zero config |
| Type check | tsc --noEmit | Separate from build — run in CI and as watch process |
| HTTP framework | Fastify | 3x faster than Express, native TS, built-in Pino logging |
| Validation | Zod v4 | 14x faster than v3, 78+ integrating libraries, ecosystem standard |
| ORM | Drizzle | SQL-like query chains, TS-native schema, tiny (5KB) |
| Migrations | drizzle-kit | Schema diffs → SQL files, comes with Drizzle |
| Testing | Vitest | 10-20x faster than Jest, native TS/ESM, same API |
| Logging | Pino | Structured JSON, 5x faster than Winston, built into Fastify |
| Linter/formatter | Biome | Replaces ESLint + Prettier, 20x faster, one tool |
| Collections | Remeda + ES2025 | Kotlin-feel pipe chains, groupBy, lazy eval |
| Error handling | neverthrow | Result\<T, E\> without exceptions |

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

ES2025 built-ins (Node 20+): `Object.groupBy()`, `Map.groupBy()`, iterator helpers (`.map()`, `.filter()`, `.take()`, `.drop()`, `.flatMap()` on iterators — lazy sequences natively).

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
import { pgTable, text, serial, boolean, timestamp } from 'drizzle-orm/pg-core';

// Schema as TypeScript
export const steeringRules = pgTable('steering_rules', {
  id: serial('id').primaryKey(),
  rule: text('rule').notNull(),
  category: text('category').notNull(),
  active: boolean('active').notNull().default(true),
  createdAt: timestamp('created_at').notNull().defaultNow(),
});

// Query — SQL-like chains with full autocompletion
const activeRules = await db
  .select()
  .from(steeringRules)
  .where(eq(steeringRules.active, true))
  .orderBy(steeringRules.createdAt);
```

Drizzle-kit generates migration SQL from schema diffs: `drizzle-kit generate` → review `.sql` → `drizzle-kit migrate`.

## Not Needed

| Tool | Why not |
|-|-|
| Next.js / Vite / Webpack | Frontend/browser tools — this is a backend service |
| Express | Slower, weaker TS support than Fastify |
| Jest | Vitest is faster with native TS/ESM |
| Winston | Pino is 5x faster, JSON-native |
| ESLint + Prettier | Biome does both, 20x faster |
| Lodash | Remeda is TS-first; ES2025 covers basics natively |
| tRPC | No TypeScript client consuming the API yet — add when a TS frontend or service-to-service calls appear |
| gRPC / ConnectRPC | Overkill for single service — add if polyglot microservices appear |
| Effect-TS | Massive learning curve, overkill for solo project |
| fp-ts | Superseded by Effect; neverthrow covers Result types |
| Prisma | Heavier than Drizzle, custom DSL instead of TypeScript schema |
| Bun (runtime) | Memory leaks in long-running processes (Jan 2026) |

## Dev Workflow

```bash
pnpm install              # install deps
pnpm dev                  # tsx watch src/index.ts
pnpm build                # tsup → dist/
pnpm typecheck            # tsc --noEmit
pnpm test                 # vitest
pnpm lint                 # biome check
```
