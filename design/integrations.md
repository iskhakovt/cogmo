# Integrations

## Interface Pattern: Messenger-Agnostic Adapters `[confirmed]`

Telegram is just transport. The bot runtime exposes a generic message handler; adapters bridge specific platforms.

```
[Telegram Webhook] -> [Telegram Adapter] -> [Message Handler] -> [Orchestrator]
[CLI stdin]        -> [CLI Adapter]       -> [Message Handler] -> [Orchestrator]
[API endpoint]     -> [HTTP Adapter]      -> [Message Handler] -> [Orchestrator]
```

Each adapter implements the `Channel` interface (see agents.md). Adding a new interface = implementing `connect()`, `sendMessage()`, `onMessage()`.

### Telegram (Primary) `[proposed]`

Webhook mode — Telegram pushes to the bot's HTTPS endpoint. Express/Fastify handler receives updates, routes to orchestrator.

| Detail | Value |
|-|-|
| Library | `telegraf` or `grammy` (TypeScript Telegram frameworks) (unconfirmed — implementation-time choice) |
| Auth | Bot token from BotFather, stored in sops |
| Webhook URL | Via Cloudflare Tunnel (`bot.timur.fyi`) or Tailscale |
| Features needed | Text messages, callback buttons (for approval flows), markdown formatting |

### Discord (Future, Team) `[research]`

Similar adapter, bot token auth, slash commands.

### CLI (Development/Testing) `[proposed]`

stdin/stdout adapter for local testing without Telegram.

## MCP Integrations `[proposed]`

MCP (Model Context Protocol) for tool/data integrations. 17,000+ servers in ecosystem (March 2026).

| Integration | MCP Server | Priority |
|-|-|-|
| Hindsight (memory) | Native MCP server | Day 1 |
| Gmail | Community | High |
| Google Calendar | Community | High |
| GitHub | Official | Medium |
| Strava | Community or custom | Medium |
| Banking | Custom (Open Banking API) | Medium |
| Linear | Official | Low (team use) |
| Slack | Official | Low (team use) |

### MCP Client Pattern `[proposed]`

```typescript
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";

// Start MCP server as subprocess
const transport = new StdioClientTransport({
  command: "npx",
  args: ["hindsight-mcp-server"],
});
const client = new Client({ name: "assistant", version: "1.0.0" });
await client.connect(transport);

// List available tools
const tools = await client.listTools();

// Call a tool
const result = await client.callTool({ name: "retain", arguments: { fact: "...", network: "bank" } });
```

### Dynamic Tool Registration (MCP Spec) `[research]`

MCP supports runtime tool creation — the agent can extend its own capabilities:

1. Server declares `"listChanged": true` in capabilities
2. Agent writes function -> registers with MCP server
3. Server emits `notifications/tools/list_changed`
4. Agent discovers own new tool on next `tools/list` call

This enables the Skill Library (evolution stage 2) — agent writes a skill, registers it as an MCP tool, immediately available.

## Skill Library `[research]`

From Voyager.

```
skills/
  code/
    summarize-email.ts
    check-spending.ts
  description/
    summarize-email.txt    # retrieval key (embedded)
    check-spending.txt
```

Code and descriptions are separated. Description embedding is the retrieval key; code is the value. Skills are compositional — new skills build on existing ones.

### SKILL.md Standard (Anthropic, Dec 2025) `[research]`

Progressive disclosure for managing skill count:

| Tier | Content | Size | When loaded |
|-|-|-|-|
| 1 | Name + description | ~50 tokens | Always (in tool list) |
| 2 | Full instructions | ~500 tokens | On trigger (tool selected) |
| 3 | Scripts/assets | Variable | On demand |

Phase transition at ~50-100 skills: selection accuracy degrades, need hierarchical organization (skill categories, multi-level retrieval).

## Permission Tiers `[proposed]`

| Tier | Actions | Examples |
|-|-|-|
| Read-only | Query, search, summarize | Email search, calendar view, spending report |
| Read-write (auto) | Create, modify low-risk items | Create calendar event, draft email (not send) |
| Read-write (approval) | Destructive or irreversible | Send email, transfer money, delete data |

Approval tier uses Inngest `waitForEvent()` + Telegram callback buttons.

## Plugin Extensibility `[research]`

Goal: open-source ecosystem where people publish and install plugins (tools, integrations, channels).

### Execution models evaluated

| Model | Idle cost | Cold start | Isolation | Can exec | Ecosystem examples |
|-|-|-|-|-|-|
| In-process import | Memory | 0 | None | Yes | Home Assistant, Obsidian, LangChain |
| MCP subprocess (stdio) | Per-process | ~100-500ms | Process | Yes | VS Code, Claude, Cursor |
| WASM (Extism) | Zero | ~1-5ms | Sandbox | No | Figma, Envoy, Helm 4 |
| Container (HTTP+SSE) | High | ~1-5s | Full | Yes | No major plugin system uses this for per-call |

### Leading candidate: WASM + capability bus

WASM plugins can't exec, can't access the network, can't touch the filesystem — unless the host explicitly grants it. This is a feature, not a bug. The host exposes capabilities through an event bus:

```
WASM plugin → request: exec("git", args) → Host ACL check → subprocess → result
WASM plugin → request: http(url)         → Host ACL check → fetch → result
WASM plugin → request: db.query(sql)     → Host ACL check → query → result
```

Benefits:
- **ACL** — host decides what each plugin is allowed to do
- **Audit** — every capability request is logged, traceable to the plugin
- **Rate limiting** — host controls concurrency per plugin
- **True sandboxing** — plugin literally cannot escape WASM, all capabilities are granted

This is capability-based security (same model as Deno permissions, Android app permissions, WASM design philosophy).

### WASM maturity (as of 2026)

- WASI Preview 2 stable — HTTP, filesystem, env vars all standardized
- Extism production-ready — used by Helm 4 for plugin sandboxing
- TypeScript-to-WASM works (AssemblyScript, ComponentizeJS) but plugins are ~12MB vs ~100KB for Rust
- **Limitation:** no subprocess spawning from within WASM — this is exactly why the capability bus pattern works

### Phased approach (not a final decision)

1. **Now:** In-process `Tool` interface, direct function calls
2. **Phase 2:** MCP client for third-party tools (subprocess isolation, proven pattern, growing ecosystem)
3. **Phase 3+:** Evaluate WASM + capability bus for open-source plugin ecosystem. MCP and WASM can coexist — MCP for power-user integrations that need full OS access, WASM for sandboxed community plugins
