Workspace-wide dependency sweep: 70 packages across all three members, every major taken, plus the toolchain pins, base images and GitHub Actions.

**Two production bugs surfaced by the bumps.**

PGlite 0.5 moves the unit tier from PostgreSQL 17 to 18 — the major dev and prod already run via `pgvector/pgvector:pg18` — and PG18 reports `ON DELETE RESTRICT` violations as SQLSTATE `23001` (`restrict_violation`) rather than `23503`. Confirmed against both majors directly:

```
postgres:17  ERROR:  23503: ... violates foreign key constraint "fk_test"
postgres:18  ERROR:  23001: ... violates RESTRICT setting of ... "fk_test"
```

The walker now matches both codes and discriminates on constraint name, so `deleteProfileClass` returns `ProfileClassInUseError` on PG18 rather than letting the raw driver error escape as a generic query failure. Matching both is enough because PG18 moves only the two `RESTRICT` paths — `NO ACTION` and orphan inserts still raise `23503`:

```
action                       pg17     pg18
DELETE + RESTRICT            23503    23001
UPDATE + RESTRICT            23503    23001
DELETE / UPDATE + NO ACTION  23503    23503
INSERT orphan child          23503    23503
```

Since they no longer match foreign-key violations alone, `findPostgresForeignKeyViolation` / `translateForeignKeyViolation` are now `findPostgresReferentialViolation` / `translateReferentialViolation` — "referential" rather than "constraint" because the pair deliberately ignores the rest of class 23 (unique, not-null, check). `findPgErrorByCode` is generic over its code list so both callers keep their literal unions without an assertion. `errors.test.ts` pins both arms plus the Drizzle cause-chain walk and the passthrough paths, none of which had direct coverage.

PG18 also makes `pg_uuidv7` redundant — `uuidv7()` is in core — so `createTestDatabase` boots plain PGlite with no extension and no SQL alias.

canonicalize 4 enforces RFC 8785 §3.2.2.2 and throws on unpaired surrogates. `canonicalJson` feeds it `tool_use.input` — model output — and the Class D stuck-loop call site in the agent loop treats the result as infallible, so a stray lone surrogate in any tool argument would have aborted the turn to protect a best-effort dedup signal. Arguments are normalized with `toWellFormed()` over strings and keys first; the encoding stays deterministic, which is the only property the fingerprint comparison needs.

**Advisories: 16 → 0.** jsdom 30 clears twelve undici findings, `@assistant-ui/react` 0.15 clears nanoid, and the three `fast-uri` host-confusion findings needed no override — ajv already allowed the patched range and the lockfile had simply never re-resolved. All seven pre-existing `overrides:` entries are dropped, each verified dead by re-resolving without it (ip-address 10.5.0, qs 6.15.3, tmp 0.2.7, shell-quote 1.10.0, hono 4.13.2, otlp-transformer 0.221.0, and `@grpc/grpc-js` gone from the tree entirely). The `@assistant-ui` core/store lockstep pins go too: the 0.15 batch resolves to one consistent tap version, which is what those pins existed to force. `overrides:` is now empty.

**Majors.** TypeScript 7's native Go compiler typechecks the workspace clean with no source changes — nothing here drives the compiler API, which is 7.0's sharpest edge before the 7.1 stable API. Pyodide moves to Python-aligned versioning (0.29.4 → 314.0.3), taking the tier-1 WASM runtime from CPython 3.13.2 to 3.14.0 and closing a Python-minor gap against tier-2's `python:3.14-slim`; the bundled package set shrinks 379 → 354 as the ecosystem rebuilds against the new ABI, which `pyodide-compat.ts` already handles by reading `pyodide-lock.json` at register time. AI SDK 7 and OpenAI SDK 7 land without source changes. Hindsight 0.9.1 moves client, `hindsightCompat`, both container image tags and the `minimumReleaseAgeExclude` entry together.

**`@daytonaio/sdk` → `@daytona/sdk`.** The old name is deprecated. Its "same API, no breaking changes" notice covers the rename but not the 0.175 → 0.204 span: `Daytona.list()` now returns a lazy `AsyncIterableIterator<Sandbox>` that pages on demand, and label filters moved under a `labels` key. Both call sites iterate with `for await`, so `deleteByTaskId` now sweeps every sandbox a task owns rather than the first page's worth — a limitation the previous single-page read carried silently. The local `require('stream')` patch is dropped; upstream replaced both sites with `dynamicImport`.

**npm 12 gates install scripts.** It adds an `--allow-scripts` allowlist independent of `ignore-scripts`, and Claude Code relies on its postinstall to place a per-platform native binary. The devbase Dockerfile names that one package on the install, so the binary lands and `claude --version` works, while everything else in the tree keeps npm 12's default deny. Without the allowlist the install reports success and the CLI fails at runtime, which is why it is named explicitly rather than left implicit.

**LiteLLM snapshot refreshed.** `data/litellm-models.json` is a vendored artefact no dependency tool watches, and it had drifted: 1891 entries to 2162, missing the whole Claude 5 family and `claude-opus-4-8`. Nothing was broken — `resolveLimits` never throws and the current default `claude-sonnet-4-6` already resolved through the key ladder's `azure_ai/` rung — but configuring a Claude 5 model would have fallen through to `DEFAULT_LIMITS`, capping it at 128k context and 4096 output tokens instead of 1M and 64k, with only a deduplicated WARN to say so.

**Record/replay fixtures re-recorded.** Three cassettes were invalidated by the bumps, each re-recorded against the real APIs and then verified in replay mode (the mode CI runs).

Daytona 0.204 sends `list()`'s label filter as a single JSON query parameter — `/sandbox?labels=%7B%22cogmo.task%22…` — which appears nowhere in the old recordings, and the lazy paging iterator collapses the call sequence (wrapper-success: 72 recorded calls down to 31).

Claude Code 2.1.233 changes the prompts the CLI sends to `/v1/messages`, so llmock had no useful response to replay. Both legs still reached `complete`, so the shutdown contract held, but the model never emitted a tool call — which is what the plan and execute assertions pin. The stream-json contract itself is unchanged: run against the real API, 2.1.233 emits only `system:init`, `assistant`, `user` and `result:success`, all shapes `claude.ts` already parses. No parser work was needed despite the coupling warning on `CLAUDE_CODE_VERSION` in `docker-bake.hcl`.

The third, `skill-authoring`, exercises both surfaces end to end. Refreshing it surfaced a latent break fixed here: it built its devbase snapshot from `Image.fromDockerfile("images/devbase/Dockerfile")`, a cwd-relative path, but Vitest runs in `apps/server` while `images/` sits at the workspace root. Record mode died before any assertion; replay never touched that path, so it stayed invisible until the cassette needed refreshing. It now resolves from the root the way `version-pins.test.ts` does.

Worth knowing for the next sweep: `pnpm test:record -- <file>` silently ignores the file filter and re-records the entire integration tier against every live upstream. Scope a recording with `RECORD=1 pnpm exec vitest run --project integration <file>` instead.
