# Telegram Adapter `[proposed]`

Telegram is the primary interactive channel. Personal DM with the bot — single user, long polling, text-first.

## Decisions

| Decision | Value | Why |
|-|-|-|
| Library | grammY (v1.41+) | TypeScript-first, 1.7M weekly downloads, active maintenance |
| Transport | Long polling for v0 | No SSL/webhook setup needed |
| Scope | DMs only — ignore group chats for now | Personal assistant, no group semantics needed yet |

## Adapter Behavior

Implements `AdapterModule` contract (`channelType` + `setup()`). Token extracted from `channel.credentials`. See [adapters.md](adapters.md) for the `Adapter` / `Transport` interfaces.

**Inbound:**
1. `bot.on("message:text")` — resolve/create session via `transport.resolveSession()` / `transport.createConversation()`
2. Send `sendChatAction("typing")` immediately
3. Call `transport.emit(session.id, content)`

**Platform address:** `String(ctx.chat.id)` — delivery target for `sendMessage`. In DMs, equals the user's Telegram ID. In groups, a separate group ID.

**Platform user handle:** `String(ctx.from.id)` — the user's Telegram ID, passed to transport for identity resolution.

**Session lifecycle:** One long-lived session per DM. Created on first message, never expires. `/new` and `/resume` close and recreate.

**Control commands:** intercepted by the adapter, never reach the agent. Each maps to a `Transport` method (see [adapters.md](adapters.md)).

| Command | Transport call | Purpose |
|-|-|-|
| `/start` | — | Welcome message (Telegram convention). |
| `/new [profile]` | `closeSession` + `createConversation` | Close current, start fresh. Optional profile name. |
| `/sessions` | `conversations.list` | Show user's conversations (see UX below). |
| `/resume <alias>` | `closeSession` + `resumeConversation({ alias })` | Switch the DM to an existing conversation by alias. |
| `/name <alias>` | `conversations.setAlias` | Set/clear an alias on the current conversation. |
| `/end` | `closeSession` | Close current session without opening a new one. Next message creates a new conversation. |
| `/profile` | `profiles.list` | Show current profile + list available. |
| `/profile switch <name>` | `conversations.setProfile` | Change the active profile of the current conversation. Effective next turn. |
| `/profile new <name>` | `profiles.create` | Interactive flow to collect prompt/model/tools, then create. |
| `/profile edit <name>` | `profiles.update` | Interactive flow to change fields. |
| `/profile delete <name>` | `profiles.delete` | Errors if conversations still reference it. |
| `/model [<model>]` | `models.list`, `profiles.update({ model })` | Without arg: show current + list. With arg: change the active profile's model. |

Errors from Transport (`profile_not_found`, `model_unavailable`, `alias_taken`, etc.) are mapped to user-friendly Telegram replies.

### Session list UX

`/sessions` adapts to size:

- **≤10 conversations** — render an inline keyboard, one button per conversation labeled `<alias or preview>` (most-recent-first). Tap routes to `/resume <alias>` (or by ID if no alias).
- **>10 conversations** — render a numbered text list with `/resume <alias>` shown as the action. Avoids Telegram's inline-keyboard density limits and keeps the surface text-only above the threshold.

The threshold is a constant in the adapter (start with `10`, tune by feel).

**Outbound:**
- `deliver()` calls `bot.api.sendMessage(platformAddress, content)`
- Markdown rendering: Telegram MarkdownV2 with escape function. For v0, plain text (LLM output contains unescaped `_*[]` that breaks Telegram's parser).

## Typing Indicator

Send `sendChatAction("typing")` once when a message arrives, before emitting the inbound event. The indicator expires after 5s — good enough for v0. Consider looping the indicator during agent processing later.

## Configuration

The adapter starts if a Telegram channel row exists in the DB. Bot token is read from `channels.credentials`.

## Testing

Unit tests use grammY transformers to capture outgoing API calls — no network, no bot token needed. Test:
- Rejects messages when identity resolution fails (unknown user in `mapped` mode)
- Calls `transport.emit()` with correct `InboundContent` for resolved users
- Handles `/start` (sends welcome, no emit)
- Handles `/new` (calls `transport.closeSession()` + `transport.createConversation()`, no emit)
- Sends typing indicator before emit
