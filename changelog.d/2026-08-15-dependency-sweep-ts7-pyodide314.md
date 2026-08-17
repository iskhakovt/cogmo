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

canonicalize 4 enforces RFC 8785 §3.2.2.2 and throws on unpaired surrogates. `canonicalJson` feeds it `tool_use.input` — model output — and the Class D stuck-loop call site in the agent loop treats the result as infallible, so a stray lone surrogate in any tool argument would have aborted the turn to protect a best-effort dedup signal. Arguments are now escaped before canonicalizing (see "Behaviour the majors moved silently" below for why that escape has to be injective, and for the two sibling rejections — non-finite numbers and cycles — that the same call site was equally exposed to).

**Advisories: 16 → 0.** jsdom 30 clears twelve undici findings, `@assistant-ui/react` 0.15 clears nanoid, and the three `fast-uri` host-confusion findings needed no override — ajv already allowed the patched range and the lockfile had simply never re-resolved. All seven pre-existing `overrides:` entries are dropped, each verified dead by re-resolving without it (ip-address 10.5.0, qs 6.15.3, tmp 0.2.7, shell-quote 1.10.0, hono 4.13.2, otlp-transformer 0.221.0, and @grpc/grpc-js 1.14.4). The `@assistant-ui` core/store lockstep pins go too: the 0.15 batch resolves to one consistent tap version, which is what those pins existed to force. `overrides:` is now empty.

Dropping them is what the block's own comment prescribes — "drop each once a dependency update pulls the patched range in directly" — and Dependabot's `npm-security` group is the standing mechanism that reopens one if an advisory returns. Worth knowing that the margin is not uniform: @grpc/grpc-js resolves to exactly 1.14.4, the floor its override enforced, so any parent narrowing its range re-resolves under a critical advisory. An `overrides:` floor ratchets; a satisfied lockfile entry does not.

**Majors.** TypeScript 7's native Go compiler typechecks the workspace clean with no source changes — nothing here drives the compiler API, which is 7.0's sharpest edge before the 7.1 stable API. Pyodide moves to Python-aligned versioning (0.29.4 → 314.0.3), taking the tier-1 WASM runtime to CPython 3.14.2 and closing a Python-minor gap against tier-2's `python:3.14-slim`.

The bundled set goes 379 → 354, but that number nets out two opposite movements and reads as pure loss if taken at face value. Seven of the removals are the `cpython_module` entries — `ssl`, `sqlite3`, `hashlib`, `lzma`, `pydecimal` and friends — which are gone from the lockfile because the unvendored-stdlib mechanism was removed, not because of ABI churn: they now ship inside `python_stdlib.zip` and **import without `loadPackage`**, so a tier-1 skill imports `ssl` / `sqlite3` / `lzma` with no `loadPackage` call and no manifest declaration. The lockfile now reports `{package: 345, shared_library: 9}` and no `cpython_module` at all, and `loadPyodide`'s `fullStdLib` option is documented as having no effect. The genuine ABI-driven shrink is the remainder. `pyodide-compat.ts` needs no change either way — it reads `pyodide-lock.json` at register time.

Cold start: `loadPyodide` plus a trivial `runPython` measures ~2.5s warm on 314, up from ~2.2s on 0.29.4 — a measurement worth carrying because `runOnWorker` spawns a one-shot worker per task, so tier-1 skills pay this per call. AI SDK 7 and OpenAI SDK 7 land without source changes. Hindsight 0.9.1 moves client, `hindsightCompat`, both container image tags and the `minimumReleaseAgeExclude` entry together.

**`@daytonaio/sdk` → `@daytona/sdk`.** The old name is deprecated. Its "same API, no breaking changes" notice covers the rename but not the 0.175 → 0.204 span: `Daytona.list()` now returns a lazy `AsyncIterableIterator<Sandbox>` that pages on demand, and label filters moved under a `labels` key. Both call sites consume the iterator, so `deleteByTaskId` sweeps every sandbox a task owns, not just one page of them. It drains the pager into an array before issuing any delete, which is what keeps a mid-enumeration failure from leaving the sweep half-done (see below). The local `require('stream')` patch is dropped; upstream replaced both sites with `dynamicImport`.

**npm 12 gates install scripts.** It adds an `--allow-scripts` allowlist independent of `ignore-scripts`, and Claude Code relies on its postinstall to place a per-platform native binary. The devbase Dockerfile names that one package on the install, so the binary lands and `claude --version` works, while everything else in the tree keeps npm 12's default deny. Without the allowlist the install reports success and the CLI fails at runtime, which is why it is named explicitly rather than left implicit.

**LiteLLM snapshot refreshed.** `data/litellm-models.json` is a vendored artefact no dependency tool watches, and it had drifted: 1891 entries to 2162, missing the whole Claude 5 family and `claude-opus-4-8`. Nothing was broken — `resolveLimits` never throws and the current default `claude-sonnet-4-6` already resolved through the key ladder's `azure_ai/` rung — but configuring a Claude 5 model would have fallen through to `DEFAULT_LIMITS`, capping it at 128k context and 4096 output tokens instead of 1M and 64k, with only a deduplicated WARN to say so.

**Record/replay fixtures re-recorded.** Three cassettes were invalidated by the bumps, each re-recorded against the real APIs and then verified in replay mode (the mode CI runs).

Daytona 0.204 sends `list()`'s label filter as a single JSON query parameter — `/sandbox?labels=%7B%22cogmo.task%22…` — which appears nowhere in the old recordings, and the lazy paging iterator collapses the call sequence (wrapper-success: 72 recorded calls down to 31).

Claude Code 2.1.233 changes the prompts the CLI sends to `/v1/messages`, so llmock had no useful response to replay. Both legs still reached `complete`, so the shutdown contract held, but the model never emitted a tool call — which is what the plan and execute assertions pin. The stream-json contract itself is unchanged: run against the real API, 2.1.233 emits only `system:init`, `assistant`, `user` and `result:success`, all shapes `claude.ts` already parses. No parser work was needed despite the coupling warning on `CLAUDE_CODE_VERSION` in `docker-bake.hcl`.

The third, `skill-authoring`, exercises both surfaces end to end. Refreshing it surfaced a latent break fixed here: it built its devbase snapshot from `Image.fromDockerfile("images/devbase/Dockerfile")`, a cwd-relative path, but Vitest runs in `apps/server` while `images/` sits at the workspace root. Record mode died before any assertion; replay never touched that path, so it stayed invisible until the cassette needed refreshing. It now resolves from the root the way `version-pins.test.ts` does.

Worth knowing for the next sweep: `pnpm test:record -- <file>` silently ignores the file filter and re-records the entire integration tier against every live upstream. Scope a recording with `RECORD=1 pnpm exec vitest run --project integration <file>` instead.

## Behaviour the majors moved silently

A review of the sweep found ten places where `tsc` and the tests stayed green while a bumped dependency changed behaviour underneath. That is the characteristic risk of a sweep this size, and it is worth recording as a class rather than as ten unrelated fixes.

**Image generation asks for base64 explicitly.** @ai-sdk/openai-compatible 3.0.13 stopped forcing `response_format: "b64_json"` on image requests but kept requiring `b64_json` in the response schema. OpenAI defaults dall-e-2/3 to `url`, so an `openai_compatible` provider generated the image, got billed, and then failed the Zod parse with a non-retryable `APICallError` — three times over, because the `withRetry` wrapper had no `shouldRetry` predicate. `image-tools.ts` now sends the flag through the SDK's `providerOptions` hook (the documented mechanism, keyed off the provider name) and `shouldRetry` excludes `ImageGenerationFailedError`, so drift costs one generation instead of three. The integration test that was supposed to pin this wire shape could not fail on it — llmock emits `b64_json` regardless of the request — so a unit test now asserts the outgoing request body through the real SDK.

**Ill-formed model output no longer wedges a turn**, at either place it lands. `jsonbZod`'s `toDriver` encodes through `stringifyWellFormedJson`, replacing lone surrogates (object keys included) before a value becomes Postgres JSON text: `tool_use.input` is `z.unknown()`, so a lone surrogate reached `JSON.stringify`, which escapes it as `\udXXX`, and Postgres rejects such a row with `22P02`. That write lives in `persist-new-messages`, after the turn's side effects, so it repeated identically on every Inngest retry while re-running those side effects. Separately `computeIterationFingerprint` is now total: its pre-pass normalized strings only, leaving non-finite numbers (`JSON.parse('{"n":1e999}')` yields `Infinity`) and reference cycles free to abort the turn from a call site with no `try`/`catch`. The string normalization also became injective — mapping every lone surrogate to one replacement character collapsed distinct object keys through `Object.fromEntries` and, running before `canonicalize`'s key sort, made the fingerprint depend on the order the model emitted keys in, which is the exact invariance `canonicalize` was chosen for.

**The 40001 retry now fires.** `isSerializationFailure` read a top-level `err.code`, but drizzle-orm wraps every statement error in a `DrizzleQueryError` that carries only `query`/`params`/`cause` — so the in-tx retry that `CLAUDE.md` and the store-pattern rule both document as a contract was dead, and every serialization conflict escaped to Inngest's step-retry budget. Same wrapped-SQLSTATE class as the `23001` bug above, so the walker is now shared from `db/pg-errors.ts` and both classifiers use it. Its tests now cover the wrapped shape and the genuinely unwrapped one postgres-js raises from its own `begin`/`commit` — a bare top-level `code` is a shape the production driver never produces, so asserting on it proved nothing.

**Smaller behaviour moves, each with the guard that would have caught it.** @anthropic-ai/sdk 0.117 added the `model_context_window_exceeded` stop reason, which fell through a `string | null` parameter to `end_turn` — where an empty turn earns a continuation prompt, adding *more* tokens to an already-overflowing context; the mapper now takes the SDK union with an exhaustiveness guard, so the next added reason is a compile error. @modelcontextprotocol/sdk 1.30 added a 10 MB stdio read-buffer cap whose overflow closes the transport, and the connection wired `onclose` but never `onerror`, so the reason was dropped; the bound is now explicit and the reason reaches the log. inngest 4.18's `timeStr` clamps sub-second durations up to 1s, so a sub-second debounce slept 1000ms while recording 500 — both now derive from one value. The Daytona SDK's `SnapshotState` and `SandboxState` gained members (`SNAPSHOTTING`; `PAUSING`/`PAUSED`/`RESUMING`) that hardcoded copies didn't know about, so a snapshot mid-capture was deleted and rebuilt, and a paused sandbox was returned as if running; both now derive from the SDK enum through total maps, and `deleteByTaskId` drains the lazy pager before deleting so a mid-enumeration failure can't leave half a task's sandboxes alive and billable.

**Two guards now hold at the level they claim.** `engines.node` said `>=24` while jsdom 30 — a runtime dependency — requires `^24.15.0 || >=26.0.0`, so installing on Node 24.0–24.14 hit an engine mismatch on a package the web-fetch path needs; the declared range is now a subset of what our dependencies allow. And no always-on PR job ran `vite build`: the only `vite build` in the repo is in the Dockerfile, reached solely by the label-gated e2e job, so a module-resolution failure of exactly the kind the deleted `@assistant-ui` pins guarded against could merge green. The web job now bundles before it runs browser tests.

Finally, PG18's core `uuidv7()` has a 12-bit sub-millisecond counter, so id-order equals insertion-order even for same-millisecond rows. Three store tests no longer need their inter-insert sleeps. One does: `listTasksForConversation` orders by `createdAt`, which defaults to `now()` and is therefore transaction-scoped, so two transactions inside one millisecond still tie regardless of the id generator.

## Review round two

A second review pass over the fixes above found eight more issues; seven held.

**Two of the earlier fixes were themselves wrong.** The image path restored
`response_format: "b64_json"` unconditionally, which fixed dall-e and broke
`gpt-image-*` — that family rejects the parameter outright
(`400 unknown_parameter`), and the setup wizard offers it as a provider option.
Sending it unconditionally is what @ai-sdk/openai-compatible v2 did and what
v3.0.13 removed; the flag is a per-model property, and it now derives from the
model id's last path segment so a gateway prefix resolves the same way. And the
`shouldRetry` predicate added alongside it never ran: `ImageGenerationFailedError`
extends p-retry's `AbortError`, which p-retry throws on before consulting the
predicate, so the error was already terminal and no attempt was ever re-billed.

Removing that predicate exposed the real defect it was sitting on. p-retry
rethrows an `AbortError`'s `originalError` — a plain `Error` when the abort was
built from a string — so a `.catch` chained outside `withRetry` and testing
`instanceof ImageGenerationFailedError` could never match, and Venice
content-policy blocks and openai-compatible moderation refusals escaped
`generate_image` as unstructured exceptions instead of a tool result. The
terminal-failure catch now lives inside the retried callback, returning the
failure as a value so no abort crosses the p-retry boundary.

**The same root cause was live in the web tools, with a billing consequence.**
`looksLikeBotBlock` tested `!(error instanceof AbortError)` to decide whether a
failed fetch was worth retrying through Tavily Extract, and that is never true
after an abort — so every permanent 4xx looked like a bot block and a 404 fell
through to Tavily, paying a credit to relay the same status, which its docstring
exists to prevent. The permanent case now carries its own error class and stops
the loop through `shouldRetry`, the only path that returns a typed error to the
caller. `web-tools.test.ts`'s `withRetry` double had preserved `AbortError`
identity and ignored `shouldRetry`, so the suite asserted a contract p-retry does
not offer; corrected, it fails against the old code. `with-retry.test.ts` now
pins both halves of that contract, and the helper's own comments no longer
describe an abort as replacing the thrown value with itself.

**Context overflow no longer lands as a successful blank turn.** Mapping
Anthropic's `model_context_window_exceeded` to `max_tokens` kept it out of the
empty-turn repair, but `classifyPostStream` has no `max_tokens` arm, so it
returned `ok` and the loop persisted the turn — blank when the overflow carried
no content, truncated-as-complete when it carried some. `StopReason` gains a
`context_overflow` member with an immediate degrade and its own subtype, chosen
over a compaction repair because compaction is a pre-flight stage and every
existing repair appends to a request the window cannot absorb. Ending the turn
hands control back to the orchestrator, whose next turn compacts the grown
history.

**The jsonb sanitizer was sanitizing the wrong thing.** It walked the input
value and skipped non-plain shapes to preserve their `toJSON`, so a `toJSON`
returning a lone surrogate — and any class instance without one, whose fields
`JSON.stringify` serializes regardless — still produced text Postgres rejects.
The invariant is a property of the encoded text, and no value walk covers every
shape `JSON.stringify` serializes without reimplementing it, so the pass now
runs over the encoded text escape by escape.

**Also:** `engines.node` and `design/skills.md`'s Pyodide reference corrected,
and the sub-second debounce clamp now pinned by feeding a raw `"500ms"` to the
real engine rather than asserting the mapping our own helper already applied.

One finding did not hold: a claim that `dispose.test.ts`'s log assertion was
vacuous because pino child loggers own their level methods. They don't, for a
single-argument `child()` — pino installs own methods only via `setLevel`, so the
child resolves `warn` through the prototype chain to the root at call time.
Removing the production log makes the test fail, which is the check that settles
it.
