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

**Session lifecycle:** One long-lived session per DM. Created on first message, never expires. `/new` closes and recreates.

**Control commands:**
- `/start` — welcome message (Telegram convention). Does not call `transport.emit()`.
- `/new` — close current session, create new conversation. Optional profile arg: `/new coder`.

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
