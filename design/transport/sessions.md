# Channel Sessions `[proposed]`

How platform addresses map to conversations. Lifecycle, types, and cleanup.

## What is a Session

A channel session is a row in `channel_sessions` that links a platform address (Telegram chat ID, Slack thread ts, Web UI tab) to a conversation. Sessions track `status` and `receive` mode but have no lifecycle events or callbacks. The agent never sees sessions.

`status` records **reachability** — whether we can deliver to the user on this channel right now. It is not a record of conversational engagement; that is inferred from `messages.created_at` on the conversation. A Telegram chat that has been quiet for hours keeps `status='active'` indefinitely, because the bot can still DM the chat_id — the user is "idle," not "unreachable." Web UI sessions are closed when their stream disconnects; `expires_at` exists on the row but nothing writes it (see [Lifecycle](#lifecycle-confirmed)).

**Session resolution:** `resolveSession(platformAddress)` returns the address's active session. If the conversation has been quiet longer than the idle window, `resolveSession` lazy-rotates — it closes the stale session and returns null, prompting the caller to create a fresh conversation for the inbound that just arrived. The lookup, the idle check and the close run in one transaction (see [Lifecycle](#lifecycle-confirmed)).

## Lifecycle `[confirmed]`

A session is a state machine ([state-machines.md](../../.agents/rules/state-machines.md)). The unit is one `channel_sessions` row; its durable id is `channel_sessions.id`. Every transition that opens a session is one store write, `swapSession`: close every active row on the address, then insert the new one. The partial unique index `uq_sessions_active_address` on `(channel_id, platform_address) WHERE status = 'active'` allows one active row per address, and the insert is keyed on it ([inngest.md](../../.agents/rules/inngest.md) → keyed insert), so an open that races another raises `40001` rather than `23505`, and the transactor's retry closes the row that won.

```
       create · supersede · resume
  ∅ ──────────────────────────────▶ active ──────────────────────────────▶ closed   (terminal)
                                          close · supersede · resume · lazy rotation
```

`status` has two values. `expires_at` has no writer: no code sets it, so no row is ever past it. The lookup behind the opens ignores the column; the routing and reachability reads still filter on it, which changes nothing while nothing writes it. A writer must come with an explicit state for an expired session and a transition that frees its address — tracked in `todo.md`.

Each transition is a use case under `src/transport/sessions/`, composed inside the caller's transaction; `Transport` and the boundary resolver call the same files.

### Transitions

| Transition | From → To | Guard | Writes | Use case |
|-|-|-|-|-|
| create | ∅ → active, or nothing | the address's active session, read in the same transaction: present → returned as `kind: "joined"` and nothing is written (the caller's profile and privacy did not apply); absent → the open | conversation insert, then `swapSession` (which closes nothing) | `create-session.ts`, behind `Transport.createConversation` — the first-message path |
| supersede | active → closed, ∅ → active | none: whatever is active on the address goes | conversation insert, then `swapSession` | `supersede-session.ts`, behind `createConversation(…, { supersede: true })` (`/new`) and a hold resolved fresh |
| resume | active → closed, ∅ → active | the target conversation exists, is the caller's and is private | `swapSession` onto it | `resume-session.ts`, behind `resumeConversation` (`/resume`, the Web UI stream open) and a hold resolved as resume |
| close | active → closed | `status = 'active'`: a conditional `UPDATE … WHERE id = $1 AND status = 'active'`; an empty RETURNING is `stale` (with the status the row holds) or `not_found` | the UPDATE | `close-session.ts`, behind `Transport.closeSession` (`/end`, Web UI disconnect, direct `/new`, reset) and the lazy rotation in `resolve-session.ts` |

Transitions not in the table are illegal; nothing reopens a closed row. A `swapSession` whose insert lands on an existing row is an invariant violation — the close in the same transaction freed the address — and throws.

### Failure modes

| Crash point or race | State left | Why it is safe |
|-|-|-|
| Two inbounds race a lazy rotation | both read the same stale session; one close commits, the other's UPDATE hits a row changed after its snapshot → `40001` → retry → the lookup finds no active row → null. Both callers then *create*; the second's insert conflicts → `40001` → its retry's lookup joins the first's session | one conversation, one active row; the second inbound lands in it |
| Two opens race on one address — supersede, resume or create, in any pairing | the loser's insert blocks on the winner's uncommitted row, then raises `40001`; its retry closes the winner's row (supersede, resume) or joins it (create) | one active row, the last committer's: the state one serial order of the two commands would leave |
| Stale close — `/end`, a Web UI disconnect, a reset or the direct adapter's `/new` against a session a swap or rotation already closed | unchanged | `closeSession` returns `stale`; `/end` tells the user the conversation had already ended, the others log it |
| Crash inside an open | nothing: the conversation insert and the swap are one transaction | — |
| A scheduled fire rotates the user's reachable channels onto its conversation (`findReachableChannelsForUserProfile` includes closed sessions) while a boundary hold is open on one of them, and the hold resolves fresh | the hold's supersede closes the fire's session and opens the fresh conversation; the buffered inbounds drain into it | consistent, at a cost: the fire's reply is skipped at delivery because its session is closed — the same outcome as a reply arriving after `/new` |
| Rows written before the index exist at deploy, two of them active on one address | `CREATE UNIQUE INDEX` would fail with `23505` | migration `0074_sessions_close_duplicate_active` closes every active row but the newest per address (highest UUIDv7 id) in its own transaction before `0075_sessions_one_active_per_address` builds the index |
| A process running the previous code while 0074–0075 apply | a plain insert of a second active row between 0074 and 0075 fails the index build and halts the migration; one after 0075 fails with `23505`, which the transactor does not retry, so that turn fails | residual: the single process is stopped before it migrates, so the window is empty in practice; a halted 0075 reruns once the duplicate is closed |

## Session Properties

| Property | Purpose |
|-|-|
| `status` | `active` \| `closed` — reachability lifecycle. Closed sessions are excluded from routing and delivery. |
| `receive` | `none` \| `routed` \| `all` — how this session receives responses |
| `expiresAt` | Nullable; nothing writes it. See [Lifecycle](#lifecycle-confirmed). |

| receive | Example |
|-|-|
| `routed` | Telegram DM, Slack thread, Direct — normal routing |
| `all` | Web UI tab — receives everything, closed when its stream disconnects |
| `none` | Muted session — input only, no responses delivered |

## Session Close Paths

Every open goes through `swapSession`, which closes whatever is active on the address first; the explicit closes are a separate transition. `status` flips to `closed` by:

1. **Supersede** — `/new`, a boundary hold resolved as fresh, a scheduled fire into an idle conversation (which rotates every reachable channel for the user+profile; see [scheduling.md](../scheduling.md) → *Synthetic conversation turn*) and a pipeline run's start.
2. **Resume** — `/resume`, the Web UI's stream open, a boundary hold resolved as resume.
3. **Lazy rotation on stale inbound** — `resolveSession` closes a session whose conversation's last message is older than the idle window and returns null; the next inbound starts a fresh conversation (or, when the prior was substantial, fires the [boundary hold](#boundary-hold-resume--start-fresh-prompt-confirmed) instead).
4. **Explicit close** — `/end`, the direct adapter's `/new`, the Web UI's stream disconnect.

The idle timer does **not** close sessions. Its only job is emitting `conversation/idle` for the Observer; reachability is unrelated to whether the user is mid-conversation.

## Boundary Hold: Resume / Start Fresh Prompt `[confirmed]`

Lazy rotation without a signal is invisible to the user: their next message lands in a fresh conversation with no prior thread context, and they don't know they could have continued the previous one. Memory + core memory still carry across, but turn-level context doesn't.

The boundary hold is a single Telegram-native UX move: on rotation, if the prior conversation accumulated at least `BOUNDARY_PROMPT_MIN_USER_TURNS` user turns, the adapter sends an inline-keyboard prompt — **"It's been a while since our last chat. Pick up where we left off, or start fresh?"** — with two buttons (`↶ Resume <alias-or-snippet>` / `✦ Start fresh`). The inbound is buffered, not persisted to `inbound_messages`, until the user picks (or the waiter times out after `BOUNDARY_PROMPT_TIMEOUT_SECONDS`).

This avoids the "first reply generated in the wrong context" failure mode of the alternative (eagerly create a fresh conversation, repair on tap): the agent never runs in a conversation the user didn't choose, so there are no side effects to reverse.

### Lifecycle

```
inbound on stale chat
   │
   ▼
resolveSession → null           ← safety-net closed the prior session
   │
   ▼
peekPriorClosedConversation     ← guarded on userTurnCount ≥ minUserTurns
   │
   ├─ null  ───────────────────▶ createConversation + emit       (today's silent path)
   │
   ▼
send prompt, persist boundary_pending, emit boundary/pending
   │
   ├─ button tapped (resume)  ─▶ swap session → prior conv,        drain buffer, emit
   ├─ button tapped (fresh)   ─▶ create new conv,                  drain buffer, emit
   ├─ /new during hold        ─▶ resolveBoundary(kind: "fresh")  ← inherits explicit profile
   ├─ /resume <alias> in hold ─▶ resolveBoundary(kind: "resume-target")
   └─ waiter timeout          ─▶ resolveBoundary(kind: "fresh", reason: "waiter_timeout")
```

Any inbound (text, photo, document, voice) that arrives while a hold is open is appended to the buffered list rather than starting a second prompt. The buffer drains in arrival order into `inbound_messages` on resolution, and one `inbound/arrived` event fires per drained row.

### Prompt cleanup on resolution `[confirmed]`

Once a hold resolves, the prompt message is rewritten in place to its settled outcome — `↶ Picking up where we left off.` / `✦ Started a fresh chat.` / `✦ No reply — started a fresh chat.` (timeout) — and its keyboard is stripped. Otherwise a resolved hold lingers as an already-answered question: a button tap leaves the question text dangling, a `/new` or `/resume` during the hold leaves the buttons live, and the waiter-timeout path leaves a keyboard whose taps only report "Already resolved."

Cleanup hangs off `boundary/resolved` rather than the channel callback, so it covers every resolution path uniformly — crucially the timeout path, where no Telegram callback runs. The event carries `promptMessageId` (copied off the holding row before it's deleted in `resolveBoundary`); the Telegram adapter registers a listener on `boundary/resolved`, filters to its own `channelId`, and edits the message. The edit is best-effort — a user-deleted prompt or a rejected edit logs at warn and no-ops; the resolution already committed and isn't reversed by a failed edit. The button-tap callback still drops the keyboard synchronously for an instant de-fang; the listener owns the authoritative text edit.

### Idempotency

Three layers of dedup keep events from double-firing:

- `boundary/pending` → `boundary-pending-${boundaryId}` (one waiter per hold).
- `boundary/resolved` → `boundary-resolved-${boundaryId}` (one resolution per hold).
- `inbound/arrived` emitted from `resolveBoundary` → `inbound-arrived-${inboundMessageId}` (one router run per drained inbound row, even if the resolve loop is retried mid-emit).

The waiter cancels on `boundary/resolved` matched on `data.boundaryId`. A button tap that races the waiter wake is harmless: `resolveBoundary` is idempotent — a second call against a deleted row returns `boundary_not_found` and the caller no-ops.

### Recovery: `boundary-janitor`

The waiter alone can't cover three failure modes:
  1. `inngest.send(boundary/pending)` fails after the holding row is inserted — no waiter ever starts.
  2. The bot process crashes between the resolver's tx commit and the per-row `inbound/arrived` emit loop — the buffer is durable but the agent never wakes up.
  3. The waiter itself fails past Inngest's retry budget.

The `boundary-janitor` Inngest function (cron `* * * * *`) scans `boundary_pending` for rows older than `now() − 2 × promptTimeoutMs` (grace > waiter window) and calls `resolveBoundary({kind:"fresh", reason:"waiter_timeout"})` per row. Same path as the waiter's timeout, idempotent against rows already drained, and emits with the same dedup ids so a waiter + janitor double-fire collapses at the bus. Max latency from orphan creation to recovery: ~2 minutes (one full cron cycle past the grace boundary).

### `expires_at`

`boundary_pending.expires_at` is set to `now() + promptTimeoutMs` at create time and is the column the janitor scans. The waiter doesn't read it (it sleeps based on the event payload); the column exists for orphan-recovery.

### Schema

```sql
boundary_pending (
  id                     UUID v7 PK,
  channel_id             UUID FK → channels NOT NULL ON DELETE CASCADE,
  platform_address       TEXT NOT NULL,
  platform_user_handle   TEXT NOT NULL,                          -- for waiter-timeout identity check
  prior_conversation_id  UUID FK → conversations NOT NULL ON DELETE CASCADE,
  prompt_message_id      TEXT NOT NULL,                          -- attach keyboard, then edit to outcome on resolve
  buffered_inbounds      JSONB NOT NULL,                         -- BufferedInboundsSchema
  expires_at             TIMESTAMPTZ NOT NULL,
  created_at             TIMESTAMPTZ NOT NULL DEFAULT now(),
  UNIQUE (channel_id, platform_address)
);
```

`UNIQUE (channel_id, platform_address)` guarantees one hold per chat — concurrent attempts surface as a constraint violation rather than dual prompts. `buffered_inbounds` is a JSONB array of `{content, platformTs}`; no `channel_session_id` is stored because at hold creation the prior session is already closed and the new one doesn't exist yet — both get assigned at drain time. `BoundaryPendingSchema` validates the JSONB at the store boundary per the standard `jsonbZod` rule.

### Configuration

| Env var | Default | Meaning |
|-|-|-|
| `BOUNDARY_PROMPT_TIMEOUT_SECONDS` | `30` | Waiter sleep before defaulting to fresh. |
| `BOUNDARY_PROMPT_MIN_USER_TURNS` | `3` | Prior must have at least this many user turns. One-shot priors stay silent. |

These gate the prompt to cases where continuation is plausibly worth the tap; everything else falls through to the silent fresh-create path.

## Session Creation

Adapters manage session lifecycle. Three invariants:

- A `user`-source inbound message points at an originating session (`inbound_messages.channel_session_id` not null). `scheduled`-source inbounds have no originating session — their `channel_session_id` is null and a check constraint enforces the link.
- A session must exist to receive a response (routing resolves target sessions).
- An address holds at most one active session (`uq_sessions_active_address`); see [Lifecycle](#lifecycle-confirmed).

Session lifecycle is adapter-specific: Telegram creates a long-lived session on first message, Slack team chats spawn a session per thread, Web UI maintains a session while a tab is open.

### `/new` Command

One call, `createConversation(address, handle, { supersede: true })`: in a single transaction, open the new conversation and swap the chat's active session for one pointing at it.

Closing the old session stops pending responses from the old conversation from being delivered. Any in-flight `outbound/deliver` events check session status before sending — closed = skip silently. This handles the "response arrives after `/new`" edge case without cancelling orchestrator runs.

### `/end` Command

Close current session (`status = 'closed'`) without creating a new one. The next inbound message will create a fresh conversation via the normal first-message flow (`resolveSession` returns null → `createConversation`). Same in-flight behavior as `/new`.

**TODO:** Consider halting in-flight processing (orchestrator run) on session closure. Currently the orchestrator finishes and the response is silently dropped at delivery. Halting would save compute but adds complexity (cancellation signal from adapter to orchestrator).


### Web UI Sessions

The SPA mints a per-tab id, which is the session's `platform_address`:

1. `POST /api/chat` opens a conversation row only (`conversations.create`). The tab keeps the stream session of the conversation it is leaving, so an in-flight reply there still lands.
2. The stream open resumes the tab onto the conversation with `receive: "all"`, closing the previous stream session.
3. The stream's disconnect closes the session.

## Reachability Lookups

`findReachableChannelsForUserProfile(userId, profileId)` returns distinct `(channelId, platformAddress, receive)` tuples for every channel the user has ever used on this profile, ordered with the latest `receive` mode per address. Closed sessions are included as a source of `(channelId, platformAddress)` tuples — a `/end`-ed Telegram chat is still reachable, and a rotation can `swapSession` onto a fresh conversation. The query filters `expires_at` as the routing reads do; nothing writes the column.

This is the canonical "where can we reach this user for this profile?" query, used by the scheduled-fire dispatcher when it rotates onto a fresh conversation.

## Cleanup

**TODO:** Consider periodic cleanup of expired and closed sessions. Both are already excluded from routing, so cleanup is only about table size — may never be needed at personal scale.

## Session and Routing

Sessions are the delivery targets for response routing. See [response-routing.md](response-routing.md) for strategies.

- **`source` routing** traces inbound messages back to their `channelSessionId`
- **`lastInbound` routing** finds the most recent inbound message's session
- **`receive: "all"` sessions** receive all responses for the conversation regardless of routing config (private conversations only)

## Aliases

Conversations can carry a human-readable alias (`'work'`, `'shopping'`) to enable resume-by-name and friendly listings. Aliases are user-set, not auto-generated:

- **Set/clear:** `transport.conversations.setAlias(conversationId, alias | null)`. Telegram surfaces this as `/name <alias>`. Web UI uses an inline rename.
- **Uniqueness:** scoped per user. Conflicts return `alias_taken`.
- **Storage:** the `aliases` table (see [data-model.md](../data-model.md), Phase 2). Separate table because aliases are sparse and users may want to rename without touching the conversation row.
- **Privacy:** only `isPrivate: true` conversations can carry aliases. Group conversations are scoped to their platform thread.

LLM-suggested auto-naming (e.g., generate an alias from the first turn) is a future enhancement — see todo. Until then, conversations without an alias appear in `/sessions` by their last-message preview.

## Non-Private Conversations

Sessions on `isPrivate: false` conversations are constrained:

- **Forced `source` routing** — responses stay in the originating thread
- **No aliases or resume** — group conversations are scoped to their platform thread (`setAlias` rejects with `access_denied`)
- **Not visible in Web UI**

## Schema

```sql
-- Enums
channel_session_status   AS ENUM ('active', 'closed');
channel_session_receive  AS ENUM ('none', 'routed', 'all');
inbound_message_source   AS ENUM ('user', 'scheduled', 'pipeline');

channel_sessions (
  id               UUID v7 PK,
  channel_id       UUID FK → channels NOT NULL,
  platform_address TEXT NOT NULL,                          -- opaque, channel-specific
  conversation_id  UUID FK → conversations NOT NULL,
  status           channel_session_status NOT NULL,
  receive          channel_session_receive NOT NULL,
  expires_at       TIMESTAMPTZ,                            -- NULL = never expires
  created_at       TIMESTAMPTZ NOT NULL DEFAULT now()
);

inbound_messages (
  id                  UUID v7 PK,
  channel_session_id  UUID FK → channel_sessions,            -- NULL ⟺ source <> 'user'
  conversation_id     UUID FK → conversations NOT NULL,
  content             JSONB NOT NULL,                        -- InboundContentSchema
  platform_ts         TIMESTAMPTZ NOT NULL,
  source              inbound_message_source NOT NULL,       -- 'user' | 'scheduled' | 'pipeline'
  idempotency_key     TEXT,                                  -- NOT NULL ⟺ source <> 'user'
  created_at          TIMESTAMPTZ NOT NULL DEFAULT now(),
  CHECK ((source = 'user' AND channel_session_id IS NOT NULL AND idempotency_key IS NULL)
      OR (source <> 'user' AND channel_session_id IS NULL AND idempotency_key IS NOT NULL))
);
-- Partial unique index — idempotency for system-originated inbounds
-- (scheduled fires: `${taskId}:${scheduledFor}`; pipeline stages:
-- `pipeline:${runId}:${stageId}:${iteration}`)
CREATE UNIQUE INDEX uq_inbound_idempotency_key
  ON inbound_messages (idempotency_key)
  WHERE idempotency_key IS NOT NULL;
```

Indexes:
- `uq_sessions_active_address` — UNIQUE `(channel_id, platform_address) WHERE status = 'active'`: one active session per address, the key of the *create* transition's keyed insert
- `(channel_id, platform_address, id DESC)` — active session lookup
- `(conversation_id) WHERE status = 'active' AND receive = 'all'` — receive-all session lookup for routing
