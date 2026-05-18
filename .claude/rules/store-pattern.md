# Store Pattern

Each domain module owns its DB access in a `store/` subdirectory:

- **`<module>/store/schema.ts`** — Drizzle table definitions owned by this module
- **`<module>/store/index.ts`** — Store interface + implementation. All DB reads/writes go through this.
- **`src/db/schemas.ts`** — Barrel file re-exporting all module schemas (for drizzle-kit migrations only)

| Store | Tables |
|-|-|
| `agent/store/` | conversations, messages, steering_rules, profiles, core_memory_blocks |
| `transport/store/` | channels, channel_sessions, inbound_messages, user_identities |

**Interface boundary, not table boundary.** A store implementation can import schemas from any module — JOINs and cross-table transactions are fine. Consumers depend on the store interface and mock it in tests. The schema defines ownership (who creates/migrates the table); the interface defines access (who can read/write what).

**Stores are stateless query objects; methods take `tx` first.** Every Drizzle store implementation has no constructor (or only the encryption key, for `DrizzleSecretsStore`) — `new DrizzleAgentStore()`. Each method takes `tx: Transaction` (exported from `src/db/index.ts`) as its first parameter and operates on `tx` directly with no internal `runInTx` wrapper. Callers own the unit-of-work boundary: pass a `Transactor` (`<T>(cb: (tx: Transaction) => Promise<T>) => Promise<T>`) into deps and wrap each call (or set of calls) in `runInTx(async (tx) => store.method(tx, args))`. Composing reads across stores — the original motivation — becomes natural: open one tx, call into multiple stores. Tests get `tx` from `createTestDatabase()`'s `{ db, tx, close }` return; unit tests use `await tx((trx) => store.method(trx, args))`. Mock-based tests use a sentinel-tx token: `const FAKE_TX = { __mockTx: true } as never; const fakeRunInTx: Transactor = (cb) => cb(FAKE_TX);` — assertions on call args use `expect.anything()` for the tx position.

**Use cases live in domain folders, named after the action.** When a workflow composes multiple store calls inside one tx (the common case as soon as anything non-trivial talks to two stores), put it in a kebab-case file under the relevant domain folder — `src/agent/conversation/load-conversation-context.ts`, `src/agent/profile/set-profile-voice-mode.ts`, etc. Single async function per file: `async function loadConversationContext(deps, args) { ... }`. `deps` carries the `Transactor` plus the store interfaces the use case touches; `args` carries per-call inputs. Tests pass a fake `deps`. No `Service` class to wrap them in — the file IS the use case. The existing `Service` interface in `src/agent/service.ts` is unrelated: that's the per-conversation tool execution context (memory, files, coreMemory ACL boundary), not an application-service layer.

**Default isolation is REPEATABLE READ.** `transactor(db)` wraps every call in `db.transaction(cb, { isolationLevel: "repeatable read" })` and retries a `40001 serialization_failure` once before surfacing it to Inngest's outer retry budget. Snapshot isolation per tx — every statement in a `runInTx` block sees the same committed-at-tx-start view. Compose reads across stores freely; no per-statement-snapshot reasoning required. Predicate races (two concurrent inserts both observing `count < cap` and both succeeding) are *not* caught by REPEATABLE READ — snapshot isolation doesn't predicate-lock. For those, the right tool is an advisory lock (`pg_advisory_xact_lock(user_id)`) or a unique partial index, not SERIALIZABLE: predicate races want prevention, not retry-on-detection. At single-user scale, the residual race on admission caps is benign and the cap-exceeded-by-1 case is documented at the relevant call sites. SERIALIZABLE is reserved for future hard-invariant paths (none today).
