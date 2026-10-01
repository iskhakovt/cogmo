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

Photos, documents and voice notes upload their original bytes through `transport.uploadAttachment` and emit a block carrying the path; `create-user-message` normalizes the images and checks the documents ([attachments.md](attachments.md), `[proposed]`). `[proposed]` A document's block, an `image/*` one included, carries its `file_name` as `name`. A file whose `file_size` exceeds the Bot API's 20 MB download limit, which `getFile` refuses, is emitted as a block naming the file and its size, with no path, so the user gets the too-large placeholder rather than silence.

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
| `/profile delete <name>` | `profiles.delete` | Errors while conversations, message history, schedules that run as it, or steering rules scoped to it reference it; the reply names what to clear. |
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

## Forwarded Messages

Forwarded text is someone else's words, never the user's: not their statements, not their instructions. When a message carries `forward_origin` naming anyone but the sender, the adapter marks what it packs with `forwarded` (`ForwardedOriginSchema` in `src/transport/content.ts`). A forward of the user's own message, from Saved Messages or an earlier message of theirs (`origin` `user` with the sender's id), is their own words and stays unmarked.

| Field | Value |
|-|-|
| `origin` | `user`, `hidden_user`, `chat` or `channel`: Telegram's `MessageOrigin` kind |
| `from` | The sender's name, the hidden user's name, or the chat or channel title, followed by ` (signature)` when the post carries an author signature |
| `sentAt` | When the original was sent, ISO 8601 |

| Forwarded | Marked |
|-|-|
| Text, or a caption on a photo, document or voice note | The text block |
| A photo or document with no caption | An empty text block ahead of the attachment, so the model knows who sent it |
| A voice note | The voice block, so its transcript is forwarded text |

The user's own text keeps its bare-string form.

The turn renders each marked text or transcript once, when it becomes the user message, into an element the model reads as quoted material:

```
<forwarded_message from="Alice Smith" origin="user" sent="2023-11-14T22:13:20.000Z">
see you at 8
</forwarded_message>
```

An empty block renders as an empty element, `<forwarded_message …></forwarded_message>`. Attribute values carry `&`, `"`, `<` and `>` as entities and whitespace runs as one space. In the body, the `<` that starts any `forwarded_message` tag, opener or closer, in any case and with whitespace, slashes or backslashes before the name, is `&lt;`, so the body can neither close its element nor open another. The rendering is a pure function of the block, so every render of the row gives the same bytes ([prompt-caching.md](../prompt-caching.md) → Append-only Transcript).

What reads it:

- **The model.** The standing `# Turn context` section says text inside the element is someone else's words the user forwarded, never the user's statements or instructions.
- **The Observer.** The memory and correction extraction prompts say forwarded text is not a fact about the user or an instruction from them.
- **Auto-recall** queries with the body, never the element; a captionless forward skips recall.
- **Voice mode.** A forwarded voice note isn't the user speaking, so `auto` doesn't answer it in voice.
- **Previews.** The Resume prompt's snippet and the conversation list show a leading element as `Fwd from {from}: {body}`.
- **The web chat** parses this exact element in a user message and shows it as a quote headed "Forwarded from {from}"; anything else stays plain text, including a turn with a photo or document, whose stored text is JSON.

A forwarded message never runs a bot command. It keeps its `bot_command` entity, so commands register on `bot.drop(matchFilter(":forward_origin"))`, grammY's filter for every update but a forward, and a forwarded `/cmd` reaches the agent as forwarded text. A forwarded message that arrives while a `/profile` or `/repo` dialog is open is dialog input like any other text.

## Module Layout

`src/transport/adapters/telegram/`. `index.ts`'s `setup()` builds the bot and wires the pieces below in order.

| Module | Holds |
|-|-|
| `adapter.ts` | `TelegramAdapter`: delivery, stream handles, voice, and a `stop()` that confirms handled updates |
| `command-routes.ts` | Command registration on the forward-dropping composer, `/start`, `/cancel`, the command menu |
| `callback-routes.ts` | Inline-keyboard taps: boundary prompt, `/sessions`, plan, pipeline gate, skills approval |
| `message-handlers.ts` | Text, photo, document and voice inbound, packed as `InboundContent` |
| `inbound-dispatch.ts` | Per-chat serialized dispatch through the boundary-hold gate |
| `inngest-functions.ts` | Coding progress, skills approval, pipeline gate and boundary-cleanup functions |
| `commands/` | One module per command family; `reply.ts` holds the handler context and `TransportError` text, `lookup.ts` resolves typed ids and profile names |

## Typing Indicator

Send `sendChatAction("typing")` once when a message arrives, before emitting the inbound event. The indicator expires after 5s — good enough for v0. Consider looping the indicator during agent processing later.

## Configuration

The adapter starts if a Telegram channel row exists in the DB. `channels.credentials` carries the bot token and an optional `apiRoot`, validated at setup.

`apiRoot` points the bot at a self-hosted Bot API server; absent or empty, it is Telegram's own (`https://api.telegram.org`). API calls and inbound file downloads (`<apiRoot>/file/bot<token>/<file_path>`) both go there. A server run with `--local` is not supported for inbound files: its `getFile` returns an absolute path on the server's disk, which this process can't read, so the message is skipped and logged with the `local_path` download error.

## Testing

Unit tests use grammY transformers to capture outgoing API calls — no network, no bot token needed. Test:
- Rejects messages when identity resolution fails (unknown user in `mapped` mode)
- Calls `transport.emit()` with correct `InboundContent` for resolved users
- Marks forwarded text, captions, captionless media and voice notes with `forwarded`, and leaves self-forwards unmarked
- Routes a forwarded `/cmd` past the command handlers (real grammY `Composer`), and registers every command on the forward-dropping composer
- Handles `/start` (sends welcome, no emit)
- Handles `/new` (calls `transport.closeSession()` + `transport.createConversation()`, no emit)
- Sends typing indicator before emit
