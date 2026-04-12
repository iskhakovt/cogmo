# Guided Setup `[proposed]`

Interactive first-run wizard and re-runnable settings flow.

## Problem

A fresh cogmo deployment requires configuring LLM provider credentials, optionally adding a Telegram channel, and seeding default data. Today this is manual — edit env vars, run `seed`, manually `INSERT INTO channels`. The wizard replaces this with a single CLI command that validates credentials, writes to the DB, and confirms the system is ready.

## Scope split

The wizard handles **infrastructure** only — providers, channels, credentials. User facts (name, timezone, preferences) are handled by the agent's existing `ONBOARDING` prompt, which fires when core memory blocks are empty. This follows the ecosystem consensus (OpenClaw, Letta, GPT Builder): wizards configure infrastructure, agents learn about users through conversation.

## UX contract

### Entry points

```bash
cogmo setup                   # interactive wizard
cogmo setup --reset secrets   # re-enter all credentials
cogmo setup --reset channels  # remove all channels, re-add
cogmo setup --reset all       # full reset (keeps migrations)
cogmo setup --non-interactive # CI/IaC: reads COGMO_* env vars, exits non-zero on missing
cogmo gen-key                 # print a fresh master key to stdout
```

### Interactive flow

The wizard is a linear sequence of steps. Each step:
1. Shows current state (secrets masked: `sk-ant-...XYZA`)
2. Offers **Keep / Modify / Skip** (Skip only for optional steps)
3. On Modify: prompts for new value, validates against the live provider, saves to DB on success
4. On validation failure: shows the error, re-prompts. Never saves an invalid credential.

| Step | Required? | Validation |
|-|-|-|
| Master key present in env | Yes | `COGMO_MASTER_KEY` or `_FILE` set |
| Database connection | Yes | `SELECT 1` |
| Migrations | Yes | Drizzle's own check |
| Default user + profile | Yes | Row count → idempotent seed |
| LLM provider (type + API key) | Yes (at least one) | `GET /v1/models` or Anthropic equivalent |
| Link default profile → provider | Yes | — |
| Tavily API key | No | Ping Tavily endpoint |
| OpenRouter key for web_answer | No | Ping endpoint |
| Hindsight URL | Yes | `GET /health` |
| S3 storage | No (defaults work for dev) | `headBucket` |
| Telegram channel | No | `getMe` → "Connected as @bot_username" |
| Telegram allowlist | If Telegram added | Parse comma-separated user IDs |
| Summary | — | Live ping each component |

### Inline help

Each credential step includes the exact click path to obtain the value:

```
Anthropic API Key
  Visit https://console.anthropic.com/
  → Settings → API Keys → Create Key
  We recommend naming it "cogmo"

Telegram Bot Token
  Message @BotFather on Telegram → /newbot → follow prompts
  The token looks like: 123456789:ABCdefGHIjklMNOpqrsTUVwxyz

Your Telegram User ID
  Message @userinfobot on Telegram — it replies with your numeric ID
```

### Re-runnable behavior

The wizard is **not a one-shot first-run gate**. It's a settings flow that happens to be the first thing you run on a fresh deployment. Running it again on an existing deployment lets you add a channel, rotate an API key, or change the LLM provider — same steps, same validation, same persistence path.

`--reset` scopes control what gets wiped before re-prompting:
- `secrets` — delete all `secrets` table rows. Re-prompts for every credential.
- `channels` — delete all channel rows and their `user_identities`. Re-prompts for Telegram etc.
- `all` — both of the above plus removes the user and profile (full re-seed).

### Non-interactive mode

For CI, IaC, or Docker entrypoint scripts. Reads from env vars with `COGMO_` prefix:

| Env var | Maps to |
|-|-|
| `COGMO_LLM_PROVIDER_TYPE` | Provider type (anthropic, openai_compatible) |
| `COGMO_LLM_API_KEY` | Provider API key |
| `COGMO_LLM_BASE_URL` | Provider base URL (optional) |
| `COGMO_TELEGRAM_BOT_TOKEN` | Telegram bot token (optional) |
| `COGMO_TELEGRAM_ALLOWED_USERS` | Comma-separated Telegram user IDs (optional) |
| `COGMO_TAVILY_API_KEY` | Tavily API key (optional) |

Validates each, writes to DB, exits 0 on success, non-zero on missing required values. No prompts.

### Library

`@clack/prompts` — modern CLI TUI with masked input, spinners, confirm prompts, multi-select. ~30 KB, MIT.

## What the wizard does NOT do

- **Write `.env` or any file.** All output goes to the encrypted DB via the secrets and transport stores.
- **Collect user facts.** Name, timezone, preferences come from the agent-led `ONBOARDING` flow during the first conversation.
- **Replace env for infrastructure.** `DATABASE_URL`, `COGMO_MASTER_KEY`, `INNGEST_*`, ports — these stay as env vars. The wizard reads them but doesn't set them.
- **Provide a web UI.** CLI only. A future web settings page would read/write the same stores.

## Persistence

The wizard writes to three stores, all DB-backed:

| Store | What the wizard writes |
|-|-|
| `secrets` (see [infrastructure.md](infrastructure.md)) | Encrypted API keys (LLM provider, Tavily, OpenRouter) |
| `llm_providers` (see [providers.md](providers.md)) | Provider config rows (type, base_url, secret FK, validation status) |
| `channels` + `user_identities` (see [transport/overview.md](transport/overview.md)) | Channel rows with encrypted credentials, identity rows for allowlist |

The wizard never constructs providers or starts adapters — it only persists config. Bootstrap reads the config on the next startup (or restart).

## Fresh install detection

Two-layer check, no dedicated marker table:

1. **Migration state:** Drizzle's `__drizzle_migrations` table. `migrate()` is idempotent — always safe to run.
2. **Bootstrap state:** `SELECT EXISTS(SELECT 1 FROM users)`. If false → fresh install. The wizard's seed step handles this.
