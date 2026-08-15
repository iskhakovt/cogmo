Workspace-wide dependency sweep: 70 packages across all three members, every major taken, plus the toolchain pins, base images and GitHub Actions.

**Two production bugs surfaced by the bumps.**

PGlite 0.5 moves the unit tier from PostgreSQL 17 to 18 — the major dev and prod already run via `pgvector/pgvector:pg18` — and PG18 reports `ON DELETE RESTRICT` violations as SQLSTATE `23001` (`restrict_violation`) rather than `23503`. Confirmed against both majors directly:

```
postgres:17  ERROR:  23503: ... violates foreign key constraint "fk_test"
postgres:18  ERROR:  23001: ... violates RESTRICT setting of ... "fk_test"
```

`findPostgresForeignKeyViolation` matched only `23503`, so `deleteProfileClass` let the raw driver error escape in production instead of translating it to `ProfileClassInUseError`; callers saw a generic query failure rather than the typed "class still in use" result. The walker now matches both codes and preserves which one fired, and `errors.test.ts` pins both arms plus the Drizzle cause-chain walk. PG18 also makes `pg_uuidv7` redundant — `uuidv7()` is in core — so `createTestDatabase` boots plain PGlite with no extension and no SQL alias.

canonicalize 4 enforces RFC 8785 §3.2.2.2 and throws on unpaired surrogates. `canonicalJson` feeds it `tool_use.input` — model output — and the Class D stuck-loop call site in the agent loop treats the result as infallible, so a stray lone surrogate in any tool argument would have aborted the turn to protect a best-effort dedup signal. Arguments are normalized with `toWellFormed()` over strings and keys first; the encoding stays deterministic, which is the only property the fingerprint comparison needs.

**Advisories: 16 → 0.** jsdom 30 clears twelve undici findings, `@assistant-ui/react` 0.15 clears nanoid, and the three `fast-uri` host-confusion findings needed no override — ajv already allowed the patched range and the lockfile had simply never re-resolved. All seven pre-existing `overrides:` entries are dropped, each verified dead by re-resolving without it (ip-address 10.5.0, qs 6.15.3, tmp 0.2.7, shell-quote 1.10.0, hono 4.13.2, otlp-transformer 0.221.0, and `@grpc/grpc-js` gone from the tree entirely). The `@assistant-ui` core/store lockstep pins go too: the 0.15 batch resolves to one consistent tap version, which is what those pins existed to force. `overrides:` is now empty.

**Majors.** TypeScript 7's native Go compiler typechecks the workspace clean with no source changes — nothing here drives the compiler API, which is 7.0's sharpest edge before the 7.1 stable API. Pyodide moves to Python-aligned versioning (0.29.4 → 314.0.3), taking the tier-1 WASM runtime from CPython 3.13.2 to 3.14.0 and closing a Python-minor gap against tier-2's `python:3.14-slim`; the bundled package set shrinks 379 → 354 as the ecosystem rebuilds against the new ABI, which `pyodide-compat.ts` already handles by reading `pyodide-lock.json` at register time. AI SDK 7 and OpenAI SDK 7 land without source changes. Hindsight 0.9.1 moves client, `hindsightCompat`, both container image tags and the `minimumReleaseAgeExclude` entry together.

**`@daytonaio/sdk` → `@daytona/sdk`.** The old name is deprecated. Its "same API, no breaking changes" notice covers the rename but not the 0.175 → 0.204 span: `Daytona.list()` now returns a lazy `AsyncIterableIterator<Sandbox>` that pages on demand, and label filters moved under a `labels` key. Iterating it also fixes a latent limitation, since the old `.items` read only the first page — a task with more sandboxes than fit one page was partially swept by `deleteByTaskId`. The local `require('stream')` patch is dropped; upstream replaced both sites with `dynamicImport`.

**npm 12 gates install scripts.** It added an `--allow-scripts` allowlist independent of `ignore-scripts`, and Claude Code relies on its postinstall to place a per-platform native binary — so the devbase global install reported success and `claude --version` then failed with "native binary not installed". The Dockerfile now names that one package explicitly, preserving default-deny for the rest of the tree.

**Known gap: the Daytona record/replay fixtures are stale.** Daytona 0.204 moved log streaming from a plain WebSocket at `/toolbox/.../logs?follow=true` to socket.io, so `daytona-mock` finds no fixture match on replay. This is a protocol change, not a cosmetic version-string difference, so it needs `RECORD=1 DAYTONA_API_KEY=… pnpm test:integration` against real Daytona rather than a matcher tweak. The llmock / fal / voice fixtures are also due a re-record on the SDK-bump trigger.
