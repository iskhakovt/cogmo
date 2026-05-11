# Guided Setup `[confirmed]`

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
| Pick at least one model for the provider | Yes | Discovered via `/v1/models`, surfaced via searchable `autocomplete` picker. OpenRouter responses include inline `context_length` / `max_completion_tokens` that flow straight into the row override; other providers fall back to the bundled LiteLLM snapshot at resolver time. Custom endpoints that don't expose `/v1/models` (or return 404) fall back to free-form text input. External-API failures prompt `retry / skip / abort` rather than auto-advancing. |
| Loop: add another model for this provider? | No | Same picker; defaults to "no" |
| Tavily API key | No | Ping Tavily endpoint |
| OpenRouter key for web_answer | No | Ping endpoint |
| Hindsight URL | Yes | `GET /health` |
| S3 storage | No (defaults work for dev) | `headBucket` |
| Telegram channel | No | `getMe` → "Connected as @bot_username" |
| Telegram allowlist | If Telegram added | Parse comma-separated user IDs |
| GitHub identity (PAT + SSH signing key) | No (required for coding-delegation) | `GET /user`; SSH keypair generated locally |
| Daytona API key | No (required for `SANDBOX_BACKEND=daytona`) | `daytona.list({}, 1, 1)` probe — returns typed errors for 401 / 403 (org-id missing) / connection |
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

For CI, IaC, or Docker entrypoint scripts. Reads from env vars with the `COGMO_` prefix when the value is a **credential** (seeded into the encrypted `secrets` table on first boot and not read again — `COGMO_LLM_API_KEY`, `COGMO_GITHUB_PAT`, `COGMO_DAYTONA_API_KEY`, etc.). **Operator config** values that the runtime keeps reading from the environment (provider URLs, org pins) keep their upstream-tool name (`DAYTONA_API_URL`, `DAYTONA_ORGANIZATION_ID`) — these are not seeded, not encrypted, and consulted on every boot.

| Env var | Maps to | Required |
|-|-|-|
| `COGMO_LLM_PROVIDER_TYPE` | Provider type (`anthropic` \| `openrouter` \| `openai` \| `custom`) | Yes |
| `COGMO_LLM_API_KEY` (+ `_FILE`) | Provider API key | Yes |
| `COGMO_LLM_BASE_URL` | Provider base URL (required when type is `custom`) | Optional |
| `COGMO_LLM_MODEL` | Model id to route to this provider. Defaults to the seeded profile's model when omitted, preserving the legacy "wire the provider, leave the model alone" flow. | Optional |
| `COGMO_LLM_CONTEXT_WINDOW` | Explicit context window override stored on the routing row. Omit to let the resolver fall through to the bundled LiteLLM snapshot → conservative default. | Optional |
| `COGMO_LLM_MAX_OUTPUT_TOKENS` | Explicit max-output-tokens override on the routing row. Same fallback semantics. | Optional |
| `COGMO_TELEGRAM_BOT_TOKEN` (+ `_FILE`) | Telegram bot token | Optional |
| `COGMO_TELEGRAM_ALLOWED_USERS` | Comma-separated Telegram user IDs | Required with token |
| `COGMO_TAVILY_API_KEY` (+ `_FILE`) | Tavily API key | Optional |
| `COGMO_FAL_API_KEY` (+ `_FILE`) | fal.ai image generation key | Optional |
| `COGMO_GITHUB_PAT` (+ `_FILE`) | GitHub identity bundle PAT (validated against `GET /user`); SSH keypair generated locally | Optional (required for coding-delegation) |
| `COGMO_DAYTONA_API_KEY` (+ `_FILE`) | Daytona API key — seeded into the encrypted `daytona_api_key` secret on first boot, never read again. | Optional (required for `SANDBOX_BACKEND=daytona`) |
| `DAYTONA_API_URL` | Daytona base URL — `undefined` defaults to Daytona Cloud. Operator config, not a credential. | Optional |
| `DAYTONA_ORGANIZATION_ID` | Pins the API key to a specific Daytona org. Required when the key has multi-org access (otherwise `daytona.list()` returns 403). | Optional |

Every secret-bearing input supports the `_FILE` convention (Docker-style — point at a file, contents used as the value).

Validation matches the interactive wizard: `/v1/models` for LLM keys, `getMe()` for Telegram, Tavily search ping. Every credential is validated *before* any DB write — a failure at any step aborts the run with a listing of failed inputs, leaving the DB untouched. fal.ai has no cheap ping endpoint; errors surface on first use.

Re-running is idempotent: an existing provider row with the same name is replaced, an existing Telegram channel is replaced with the new credentials and allowlist. Use `--reset secrets` / `--reset channels` / `--reset all` for explicit wipes.

Exits 0 on success, non-zero on missing required env vars or validation failures. No prompts.

**Status:** `[confirmed]`. Implemented in `src/setup/non-interactive.ts`. See `src/setup/env.ts` for the Zod schema.

### Post-setup CLI

Provider and model management after first-run lives in dedicated subcommands so operators don't have to re-run the whole wizard to add a single model:

| Command | Purpose |
|-|-|
| `cogmo provider add <type> <name> <api-key> [base-url]` | Register a new provider. Validates the key the same way the wizard does. |
| `cogmo provider list` | Show registered providers (name, type, base URL). |
| `cogmo provider remove <name>` | Delete a provider; cascades to its `model_providers` rows. |
| `cogmo model add <id> --provider <name> [--context N --max-output N --position N]` | Insert a routing row. `--context` / `--max-output` override the bundled LiteLLM defaults; omit to let the resolver pick. |
| `cogmo model list [--model <id>] [--provider <name>]` | Show routing rows with effective limits and source (`db`/`litellm`/`default`). |
| `cogmo model remove <id> [--provider <name>]` | Remove one row or every row for the model. |

Both CLIs share their domain functions with the wizard (`src/agent/provider/add-provider.ts`, `src/agent/provider/add-model-routing.ts`) — the wizard is a thin interactive front-end over the same code path.

### Library

`@clack/prompts` — modern CLI TUI with masked input, spinners, confirm prompts, multi-select, and (new) `autocomplete` for searchable pickers used by the model step. ~30 KB, MIT.

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
