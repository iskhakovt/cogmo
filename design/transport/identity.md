# Identity & User Attribution `[proposed]`

How platform users map to internal users, and how conversations are scoped.

## Identity Resolution

Each channel has an identity mode controlling how platform users map to internal users:

| Mode | Behavior | Use case |
|-|-|-|
| `fixed` | All messages map to one user (wildcard identity) | Personal TG agent, Direct |
| `mapped` | Lookup by platform handle, reject if not found | Family / corp — pre-registered users only |
| `create` | Lookup by platform handle, create if not found | Open access, Web UI signup |

Identity resolution is internal to the transport layer — adapters pass `platformUserHandle`, the transport resolves it. See [adapters.md](adapters.md).

The mode determines which query to run — no fallback logic:

| Mode | Query | On miss |
|-|-|-|
| `fixed` | `WHERE channel_id = ? AND is_wildcard = true` | — (always exists) |
| `mapped` | `WHERE channel_id = ? AND platform_handle = ?` | Reject |
| `create` | `WHERE channel_id = ? AND platform_handle = ?` | Auto-create user + identity |

### Invariant

The channel's `identity_mode` determines which type of `user_identities` records are allowed. Enforced at the application level by whatever writes identity records (channel setup, admin operations, `create` mode auto-creation) — not via DB constraint.

| Mode | Allowed records |
|-|-|
| `fixed` | Exactly one wildcard record (`is_wildcard = true`, `platform_handle = NULL`) |
| `mapped` | Per-handle records only (`is_wildcard = false`, `platform_handle NOT NULL`) |
| `create` | Per-handle records only (`is_wildcard = false`, `platform_handle NOT NULL`) |

Wildcard and per-handle entries never coexist on the same channel.

**Future consideration:** PostgreSQL EXCLUDE constraint with `int4range(hashtext(platform_handle), ...) WITH &&` can enforce this at the DB level — `hashtext(NULL)` produces an unbounded range that overlaps everything. Requires `btree_gist` extension and has a theoretical hash collision caveat on non-NULL values. Evaluate if app-level enforcement proves insufficient.

## Schema

```sql
users (
  id               UUID v7 PK,
  created_at       TIMESTAMPTZ NOT NULL DEFAULT now()
);
```

```sql
user_identities (
  id               UUID v7 PK,
  user_id          UUID FK → users NOT NULL,
  channel_id       UUID FK → channels NOT NULL,
  platform_handle  TEXT,                        -- NULL for wildcard entries
  is_wildcard      BOOLEAN NOT NULL,            -- true ⟺ platform_handle IS NULL
  auto_created     BOOLEAN NOT NULL,
  created_at       TIMESTAMPTZ NOT NULL DEFAULT now(),
  UNIQUE NULLS NOT DISTINCT (channel_id, platform_handle), -- one wildcard per channel (PG15+)
  CHECK (is_wildcard = (platform_handle IS NULL))
);
```

The `user_identities` table IS the allowlist. No separate allowlist mechanism needed.

### Allowlist enforcement `[proposed]`

Channel adapters check identity on each inbound message before routing to the orchestrator. For channels in `mapped` mode (e.g., Telegram with a configured allowlist), the adapter calls `transportStore.resolveUser(channelId, platformHandle)`. If no identity row matches, the message is rejected with a user-facing reply ("Not authorized").

For `fixed` mode channels (e.g., Direct), the wildcard identity accepts all messages — no per-message check needed.

The setup wizard populates `user_identities` rows for each Telegram user ID in the allowlist. The `TELEGRAM_ALLOWED_USERS` env var is superseded by these DB rows.

## User Attribution

The userId lives on the conversation (`conversations.userId`). The conversation owner is the user who created it — resolved from identity at conversation creation time.

In group chats (`isPrivate: false`), the conversation is still owned by one user — the one who invoked the agent. Other people's messages are context, not separate user attributions.

## Memory Scoping

The agent always knows **who** is talking (userId on conversation). But knowing who != accessing their private memory. `isPrivate` on conversations controls memory scope.

| Context | isPrivate | Memory access |
|-|-|-|
| DM with agent | `true` | User's full personal memory |
| Group thread (future) | `false` | Shared/workspace memory only |

```typescript
const tags = conversation.isPrivate
  ? ["personal", `user:${userId}`]   // full personal memory
  : ["shared"];                       // workspace-only
```

**Why not scope by userId alone?** User A shares personal info in a DM, then @mentions the agent in a group. If memory scoped by userId, the agent could leak A's personal data into a group response.

Adapter sets `isPrivate` when calling `createConversation()`.

## Group Chats

Group conversations (`isPrivate: false`) are scoped to their platform thread:

- Forced `source` routing — responses stay in the originating thread
- No aliases or resume
- Not visible in Web UI
- Conversation owned by the invoking user

The agent may see messages from other participants (platform-dependent — Slack threads include all replies, Telegram groups include all messages). These are context for the agent, not separate user attributions. The conversation's userId determines memory access and billing.
