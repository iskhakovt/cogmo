# Operator Facade `[proposed]`

Splitting `Transport` into the channel contract adapters need and the operator-command surface every edge needs, moving the inbound content model to the domain, and hoisting the logic that has accumulated in the facade into use cases. This doc is the plan; sections become `[confirmed]` as their slices land. Reviewed once against the code (2026-10-27); the Problem table and gaps below are the corrected claims.

## Problem

`Transport` (`src/transport/transport.ts`) is a 17-line interface over fifteen namespaces, built once per channel by `startChannels`. On main at e2962085:

| Fact | Consequence |
|-|-|
| Telegram command and callback routes call every namespace; the web RPC router calls one or two methods on each; the CLI calls none; `agent/` and `skills/` call none. | The facade is the operator-command surface, not transport. The CLI reaches stores directly for operations the facade has (skills, scheduling, subagent) and re-implements operations the setup wizard has and the facade lacks (provider, image-provider, model routing), so domain rules such as "extra-body is OpenAI-compatible only" are enforced in `cli/model.ts` and nowhere else. |
| One namespace (`profile-classes`) delegates to `agent/` use cases; the other fourteen run their logic inline against stores, `SkillRunner`, `McpRegistry` or `inngest.send`. `repos.cloneAndAdd` spawns git; the cooldown-clear policy is written three times (`profiles.update`, `conversations.setProfile`, `conversations.repair`); `conversations.summary` computes a token budget from `llm/models`; `coding.approvePlan`/`cancelTask` and `pipelines.resolveGate` do ownership, store writes and the emit inline. | One concept, fourteen shapes; none reusable by the CLI or testable without the facade. |
| `TransportDeps` has nine optional dependencies plus `sessionReceive`; five namespaces emit four `*_disabled` codes at nineteen sites, and `evolution`, `compaction` and `github_identity` have their own `*_unavailable` codes. | Feature availability is nullable deps, re-derived per call. |
| About 45 methods resolve `(channelId, platformUserHandle) → userId` themselves, then check ownership, call, and map errors; `repos.*`, `models.list`, `mcp.toolBudget` and `boundary.*` resolve nothing. | The invariant that matters (identity first; cross-user reads collapse to `*_not_found`) is copy-pasted and cannot be audited in one place, and four namespaces skip it without saying so. |
| `transport/content.ts` holds the inbound block schema, the conversion to LLM `ContentBlock`s, the forwarded-text renderer, the `/sessions` preview and the 20 MB download cap; six `agent/` files import it as a value. The other `agent → transport` value edges are `pushOrThrow` (three files) and the `inboundMessages` schema in `agent/store/transcript.ts`. | The domain's own vocabulary lives in an edge module. |
| AGENTS.md describes `transport/` as "how messages arrive and responses are delivered"; `design/transport/adapters.md` lists four namespaces and nine error codes against fifteen and about sixty; `identity.md:15` and `adapters.md:105` say adapters never see user ids. | A reader of the rules cannot find where operator commands belong. |

## Target shape

```
src/transport/                      channel contract: adapters, sessions, identity, boundary, chat defaults, delivery, store
  transport.ts                      interface Transport   (one per channel)
src/operator/                       application facade: operator commands over the domain
  operator.ts                       interface Operator    (one per process)
  principal.ts                      class Principal + the two minters
  errors.ts                         OperatorError
  namespaces/*.ts                   validate ids → use case → error map, nothing else
src/agent/conversation/inbound-content.ts    the inbound block model (from transport/content.ts)
```

### `Principal` `[proposed]`

```typescript
/** A resolved caller. Minted only in this file; adapters receive it opaque. */
export class Principal {
  readonly #userId: string;
  readonly via:
    | { kind: "channel"; channelId: string; identityId: string; handle: string }
    | { kind: "owner" };          // the bootstrap owner acting from the CLI or an automated trigger
  // constructor is module-private
}
/** Transport-side minter: resolves the handle on this channel. */
export function resolvePrincipal(…): Promise<Result<Principal, { code: "identity_rejected" }>>;
/** Owner minter for the CLI runner; takes the owner the bootstrap already resolved. */
export function ownerPrincipal(userId: string): Principal;
/** Operator-internal accessor. */
export function userIdOf(p: Principal): string;
```

- The class has a `#private` field, so no object literal type-checks as a `Principal` and only `principal.ts` can construct one. `userIdOf` is exported for `src/operator/`; a Biome `noRestrictedImports` override on `src/transport/adapters/**`, `src/web/**` and `src/cli/**` forbids importing it, so an adapter holds the value but cannot read the id. This keeps `identity.md`'s rule ("adapters never see user ids") true in letter as well as spirit.
- `via.owner` maps onto the existing `SkillDeployOrigin { kind: "owner" }` (`skills/deploy/origin.ts:21`); `via.channel` carries the `identityId` that `SkillActor` and `skill_deploys.approved_by` need.
- A channel-minted principal is valid only on its channel: `Transport` methods on channel B reject a principal whose `via.channelId` is A with `identity_rejected`. An owner principal is accepted by any `Transport`.
- `ownerPrincipal` is not on `Operator` and not reachable from `AdapterDeps`. The CLI runner (`cli/run.ts` dependency loader) and `boot/` are its only callers; `TransportDeps.defaultUserId`, which `createTransport` never reads today, is the owner id they pass.

### `Transport` (per channel) `[proposed]`

```typescript
interface Transport {
  senders: { admits(handle: string): Promise<boolean> };
  identify(handle: string): Promise<Result<Principal, { code: "identity_rejected" }>>;
  resolveSession(address: string): Promise<Session | null>;
  createConversation(address: string, principal: Principal, opts: …): Promise<Result<Session, TransportError>>;
  resumeConversation(address: string, principal: Principal, target: …): Promise<Result<Session, TransportError>>;
  closeSession(sessionId: string): Promise<void>;
  emit(sessionId: string, content: InboundContent, platformTs: Date): Promise<Result<void, TransportError>>;
  uploadAttachment(data: Buffer, mediaType: string): Promise<string>;
  current(principal: Principal, address: string): Promise<CurrentConversation | null>;   // today conversations.getCurrent
  chats: ChatsNamespace;          // per-address default profile
  boundary: BoundaryNamespace;    // per-chat hold
}
type TransportError =
  | { code: "session_not_found"; sessionId }
  | { code: "identity_rejected" }
  | { code: "conversation_not_found" }
  | { code: "alias_taken" }
  | { code: "operation_not_permitted" }
  | { code: "access_denied"; reason };
```

Everything address-keyed stays here. The three operator-side methods that take an address today (`evolution.triggerReflection`, `skills.approveDeploy`, `skills.enable`) and `conversations.compact` become id-keyed on the operator: the adapter calls `transport.current(principal, address)` first and passes the conversation id (or `null`, for `approveDeploy`'s "tapped outside a conversation" case that `SkillDeployOrigin.user.conversation` already models).

### `Operator` (one per process) `[proposed]`

```typescript
interface Operator {
  conversations: { list, getMessages, summary, setAlias, setProfile, repair, compact, setVoiceMode };
  profiles; profileClasses; compartments; models; repos; coding; pipelines; skills; scheduling; mcp; evolution;
}
```

Every method takes a `Principal` first. System-level reads (`models.list`, `repos.list`, `mcp.toolBudget`) take it and ignore it, documented as such on the method, so a later per-user policy needs no API change.

### `OperatorError` `[proposed]`

```typescript
type OperatorError =
  | { code: "conversation_not_found" } | { code: "alias_taken" } | { code: "operation_not_permitted" } | { code: "access_denied"; reason }   // shared with TransportError
  | { code: "invalid_id"; field: string }                                   // any id argument that is not a UUID, before the first query
  | { code: "feature_disabled"; feature: OperatorFeature }                   // replaces repos/sandbox/skills/pipelines/mcp `*_disabled`
  | … every other current TransportError code except session_not_found and identity_rejected …
```

- `identity_rejected` leaves the operator side: a `Principal` is the proof. The coding and pipelines ownership checks that return it today return `task_not_found` / `pipeline_run_not_found` instead, the same collapse the other namespaces use.
- `schedule_id_malformed` is replaced by `invalid_id`. `evolution_unavailable`, `compaction_unavailable` become `feature_disabled`; `github_identity_unavailable` stays (it is a runtime condition, not a feature switch).
- One union, mirrored in `packages/contracts` through the existing parity assert. The Telegram error renderers (`commands/reply.ts`, `repo-dialog.ts`) and the SPA re-narrow change in the same PR as the codes.

### Feature availability `[proposed]`

```typescript
interface OperatorFeatures {
  coding?: { codingStore; secretsStore; reposDir };      // also serves `repos`
  skills?: { skillRunner; skillStore };
  pipelines?: { pipelineRunStore };
  mcp?: { mcpRegistry };
  evolution?: { triggerReflection };
  compaction?: { compactConversation };
}
```

`createOperator(core, features)` reads the bag once. An absent feature yields a namespace stub: every `Result`-returning method returns `feature_disabled`; the two non-`Result` reads become `Result` in slice 2 (`mcp.toolBudget`) or keep their explicit "not wired" value (`summary.mcp: null`). Core deps (`runInTx`, `agentStore`, `transportStore`, `inngest` as the `EventPublisher` from the durable-step port) are required. `Transport` keeps `sessionReceive`, `idleTimeoutMs`, `defaultProfileId`, `attachments` as its own config; nothing optional remains on it.

### Namespace rule `[proposed]`

A namespace method validates its id arguments (`invalid_id`), calls one use case in `src/agent/<domain>/<verb>.ts` (or `src/skills/`, `src/mcp/`) with `userIdOf(principal)`, and maps the use case's error union onto `OperatorError` with `match().exhaustive()`. Ownership checks live in the use case, so the CLI gets them too.

## Design decisions

| Decision | Choice | Why | Rejected |
|-|-|-|-|
| Split axis | By consumer (channel contract vs operator commands) | Namespaces are already by domain; what differs is who calls them and with what identity. An adapter should see a small contract. | N domain facades: fifteen objects to inject, no smaller adapter contract. |
| Identity handoff | A branded `Principal` class minted only by transport and the CLI runner | Keeps identity resolution inside transport, lets the operator be process-wide, gives the CLI an explicit identity, and cannot be forged by an adapter. | `userId: string` (any string passes). A structural `Principal` interface (any literal passes). Operator per channel (keeps N instances and the handle leak). |
| Where ownership checks live | In the use case, keyed on the user id | Reaches the CLI and any future edge; the facade cannot forget. | In the facade: every edge that bypasses it bypasses the check. |
| Address-keyed methods | All on `Transport`; operator methods are id-keyed, adapters resolve the address first via `transport.current` | One rule, no exceptions, and the operator never needs a channel. | Operator resolves the session from `via.channelId`: re-introduces channel knowledge into the operator. |
| Error unions | Two explicit unions with four shared codes; one `OperatorError` mirrored in contracts | The web client re-narrows on `data.code`; one mirror is enough. | Per-namespace unions: fifteen mirrors and fifteen `unwrap` variants. |
| Content model | Whole of `content.ts` moves to `agent/conversation/inbound-content.ts`, including `previewInboundText` and `MAX_INBOUND_FILE_BYTES`; transport's schema imports the Zod schema from there | It is the domain's value object; `transport → agent` is the direction the architecture wants; the table stays transport's. The preview is called from two stores, and the cap applies to every channel's originals, so neither belongs to an adapter or a namespace. | Leave in transport; shared-kernel module for one file; scatter the preview and cap (would create `transport/store → operator` and `agent → adapter` edges). |
| `runGit` | Stays in `secrets/git-askpass.ts` for this plan | Nine callers across coding, skills, transport; `src/util/` is stateless helpers only (AGENTS.md), so it cannot go there, and a new `src/git/` module is an architecture change to decide on its own. | Moving to `util/` (violates the module rule). |
| Module name | `src/operator/` | Matches "operator" as the repo already uses it for `cogmo` commands. | `src/app/` (says nothing); `src/admin/` (`data-model.md` deliberately has "no admin role in code"). |

## Design gaps found while planning

1. **The CLI has no identity model.** It reaches stores directly and calls `getFirstUser` where it needs a user (`cli/subagent.ts`, three times). `SkillDeployOrigin.owner` already names the concept; `ownerPrincipal` makes it the one way the CLI acts. `getFirstUser` stays for `boot/`, `main.ts` and `seed.ts`, which resolve the owner at startup.
2. **System-level operations have no stated policy** (`models.list`, `repos.*`, `mcp.toolBudget`, `boundary.*` resolve no identity). Uniform principal argument; "system-level, principal ignored" written on each.
3. **Feature-disabled is derived per call from nullable deps**, under three different code families (`*_disabled`, `*_unavailable`, optional callbacks). One `features` bag, one code.
4. **A non-UUID id is a crash, not an error**, on the web path: `rpc-contract.ts` accepts `z.string()` for ids and only `scheduling` guards. (Telegram callback regexes already pin a UUID.) One `invalid_id` guard at the operator boundary.
5. **Facade logic is tested only against a mocked store.** Hoisted use cases get PGlite tests for ownership and the cross-user `*_not_found` collapse. The `40001` convergence the keyed inbound inserts rely on needs the real driver and stays in the integration tier (`keyed-insert.integration.test.ts` is the shape); it is out of scope here.
6. **`AdapterModule` is a plugin boundary and it changes.** `AdapterDeps` gains `operator`. The Adapter Interface and Trust Boundary sections of `adapters.md`, the AGENTS.md row and the namespace rule land in the split PR itself, not after.
7. **The cooldown clear is written three times** (`profiles.update`, `conversations.setProfile`, `conversations.repair`). One use case, `agent/conversation/clear-cooldown.ts`, emitting through the `EventPublisher` port.
8. **`conversations.summary` is a read model** computed in the facade from `llm/models` limits. It belongs in `agent/conversation/summarize-conversation-state.ts`.
9. **`repos.cloneAndAdd` runs git from a facade method** with the URL validated only as non-empty and no `--` before it. The use case validates the scheme (`https://`, `git@`, `ssh://`; reject a leading `-`) and passes `--`. This is a behaviour change and gets a red-first test.
10. **The web gate already resolves a user id** from `web_sessions` and then passes the owner *handle* to every call. After the split the gate mints the `Principal` through the web channel's `transport.identify(ownerHandle)`; the session's `user_id` must match it, and a mismatch is a 401 and a warn log. The chat path uses the same principal.
11. **Design docs disagree on what `Transport` is**, and `identity.md:15` / `adapters.md:105` state a rule (`adapters never see user ids`) that the branded `Principal` preserves and that the doc rewrite must keep.
12. **Test factories.** `mockTransport*` is used directly in 15 files (49 call sites) and by 18 more through `telegram/{harness,command-fixtures}.ts`. The factory gets an `Operator` twin; the churn lands with the signature change (slice 2), not the split.
13. **Identity resolution is mode-agnostic** (`resolveIdentity` tries the wildcard row first regardless of channel mode; no CHECK ties `is_wildcard` to the mode). `transport.identify` queries only the channel mode's row type, with a red-first test for the stray-wildcard case.
14. **`transport/command-service.ts`** is a second control-command surface with no production caller. Slice 3 deletes it.
15. **Prerequisite.** `EventPublisher` is defined by the durable-step port PR (in flight; `src/inngest/`). Slice 1's cooldown and coding/pipelines rows depend on it; slice 0 does not.

## Migration plan

Logic moves before interfaces change, so the split is mechanical. `main` is consistent after every PR.

### Slice 0 — content model (one PR) `[confirmed]`

- `git mv transport/content.ts agent/conversation/inbound-content.ts`, tests alongside. Nothing is split out: schema, block types, `contentToBlocks`, `contentToText`, `isVoiceContent`, `renderInboundText`, `previewInboundText`, `MAX_INBOUND_FILE_BYTES` all move.
- `transport/store/schema.ts` imports `InboundContentSchema` from the new path; the other importers (`agent/handle-message/*`, `agent/recall-gate.ts`, `agent/attachments/normalize-arrival.ts`, `agent/store/conversations.ts`, `transport/namespaces/sessions.ts`, `transport/store/index.ts`) update their import lines only.
- Docs: `transport/overview.md` Data Model notes where the schema lives; `data-model.md` `inbound_messages` row. Changelog fragment.
- Test: a PGlite store test that `inbound_messages.content` rejects a malformed block through `jsonbZod`. This is a characterization test (it passes before and after); it exists because the import direction changed.

### Slice 1 — hoist facade logic into use cases (one PR per namespace) `[proposed]`

No interface change. Each PR hoists one namespace's methods into `(deps, args)` use cases with PGlite tests, leaving the namespace as validate → call → map. Behaviour changes only where a row says so.

| Namespace | Use cases | Notes |
|-|-|-|
| `repos` | `agent/coding/{clone-repo,add-repo,remove-repo}.ts` | URL validation and `--` (gap 9, red-first test). `runGit` stays where it is. |
| `profiles` | `agent/profile/{create,update,delete,set-class}-profile.ts`; `agent/conversation/clear-cooldown.ts` | Gap 7; the clear use case is shared with `conversations`. Needs `EventPublisher`. `delete`'s count-then-delete lives in the store and is a separate fix, not this plan. |
| `conversations` | `agent/conversation/{summarize-conversation-state,set-alias,set-profile,repair-conversation,set-voice-mode,compact-conversation-for-user}.ts` | Gap 8; `setProfile`/`repair` reuse `clear-cooldown`. `compactionFailureReason` moves as is. |
| `coding` | `agent/coding/{approve-plan,cancel-task}.ts` | Ownership + conditional transition + emit, through `EventPublisher`. |
| `pipelines` | `agent/pipeline/resolve-gate-for-user.ts` | Gate-token check + emit. |
| `scheduling` | `agent/scheduling/{list,remove,…}-scheduled-task.ts` | Ownership and the id guard move; the guard becomes the shared `invalid_id` in slice 2. |
| `evolution`, `compartments` | `agent/evolution/*`, `agent/core-memory/*` | Store-direct today. |
| `skills`, `mcp` | `skills/deploy/{approve,deny,enable}.ts` already exist; `mcp/parse-server-config.ts` | Only the MCP config parse is logic; the registry already returns `Result`s, so the `mcp` namespace mostly loses its disabled checks. |
| `chats`, `boundary`, `senders`, `sessions` | stay transport-side; `chats.*` and the session rotation move to `transport/{chat-defaults,sessions}/*.ts` use cases | Out of the namespace, not out of the module. |

### Slice 2 — `Principal`, `identify`, `invalid_id`, `features` (one PR) `[proposed]`

Still one facade. `principal.ts` with the class and both minters; `Transport.identify`; every namespace method's first argument becomes `Principal`; `invalid_id` at every id argument; `OperatorFeatures` replaces the optional deps and the `*_disabled`/`*_unavailable` codes become `feature_disabled` (contract, SPA re-narrow and Telegram renderers in the same PR); `identify` queries by channel mode (gap 13, red-first). The Telegram routes and the web gate call `identify` once per update/request (gap 10). This PR carries the factory churn (gap 12). The Biome restricted-import override for `userIdOf` lands here.

### Slice 3 — the split (one PR) `[proposed]`

- `src/operator/` with `Operator`, `OperatorError`, `createOperator`; namespace files `git mv`'d from `transport/namespaces/`; `Transport` shrinks to the channel contract; the four address-keyed operator methods become id-keyed and their adapter callers resolve via `transport.current`.
- `AdapterDeps` gains `operator`; `startChannels` builds one `Operator` and hands it to every adapter; `boot/web.ts` and the RPC context carry both; `ownerPrincipal` is wired into the CLI runner and the CLI commands that duplicate facade operations call `operator.*`.
- `packages/contracts`: `TransportErrorSchema` → `OperatorErrorSchema`, `TRANSPORT_ERROR` → `OPERATOR_ERROR`, parity assert kept.
- `transport/command-service.ts` deleted.
- Docs in the same PR: AGENTS.md `src/operator/` row and the shrunk `src/transport/` row; the namespace rule in `store-pattern.md`; `adapters.md` Transport, Adapter Interface and Trust Boundary sections rewritten to point at the two interface files; `identity.md:15` and `adapters.md:105` reworded for the opaque `Principal`; `web-ui.md` Admin path; `overview.md` glossary (`Operator`, `Principal`); this doc's sections → `[confirmed]`; a `todo.md` entry per slice is added when this doc merges and deleted as each lands.

## Test strategy

- Slice 0: existing tests move; one characterization store test (above).
- Slice 1: each hoisted method's existing namespace test runs against the use case before the namespace is thinned, so the red is a wrong value where behaviour changes (gap 9) and the typecheck where it does not. PGlite tests for ownership and the cross-user `*_not_found` collapse on every use case that has one.
- Slice 2: `invalid_id` matrix (one bad id per id argument); `identify` mode matrix (fixed / mapped / create × wildcard row present / absent), red first on the stray-wildcard case; `feature_disabled` per stub; a compile-time test that a `Principal` literal does not type-check; the Biome override has a positive and a negative fixture like `biome-plugin.test.ts`.
- Slice 3: typecheck and `contracts-parity.ts` are the gates; one integration test runs a Telegram control command and one web RPC call through the new wiring.
- Throughout: `pnpm typecheck && pnpm lint && pnpm knip && pnpm test`; integration files touched run alongside their noisiest peers per testing.md.

## Risks

- **Scope creep in slice 1.** Each PR hoists one namespace and changes behaviour only where the table says. The store-level fixes the review found (`profiles.delete`, keyed inbound insert) are separate PRs.
- **Contract break for the SPA and Telegram renderers.** `feature_disabled`, `invalid_id` and the rename change `data.code` values both re-narrow on. Each lands with its consumers in the same PR; the parity assert catches a missed mirror.
- **Replay-safe emits.** The hoisted coding, pipeline and cooldown emits must keep their event names and idempotency ids; the durable-port `EventPublisher` is the prerequisite and the replay tests are the gate.
- **A half-moved tree.** Slice 3 is a large mechanical diff and is one PR, opened and merged the same day.
