# Integrations

## Interface Pattern: Messenger-Agnostic Adapters

Telegram is just transport. The bot runtime exposes a generic message handler; adapters bridge specific platforms.

```
[Telegram Webhook] -> [Telegram Adapter] -> [Message Handler] -> [Orchestrator]
[CLI stdin]        -> [CLI Adapter]       -> [Message Handler] -> [Orchestrator]
[API endpoint]     -> [HTTP Adapter]      -> [Message Handler] -> [Orchestrator]
```

Each adapter implements the `Channel` interface (see agents.md). Adding a new interface = implementing `connect()`, `sendMessage()`, `onMessage()`.

### Telegram (Primary)

Webhook mode — Telegram pushes to the bot's HTTPS endpoint. Express/Fastify handler receives updates, routes to orchestrator.

| Detail | Value |
|-|-|
| Library | `telegraf` or `grammy` (TypeScript Telegram frameworks) |
| Auth | Bot token from BotFather, stored in sops |
| Webhook URL | Via Cloudflare Tunnel (`bot.timur.fyi`) or Tailscale |
| Features needed | Text messages, callback buttons (for approval flows), markdown formatting |

### Discord (Future, Team)

Similar adapter, bot token auth, slash commands.

### CLI (Development/Testing)

stdin/stdout adapter for local testing without Telegram.

## MCP Integrations

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

### MCP Client Pattern

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

### Dynamic Tool Registration (MCP Spec)

MCP supports runtime tool creation — the agent can extend its own capabilities:

1. Server declares `"listChanged": true` in capabilities
2. Agent writes function -> registers with MCP server
3. Server emits `notifications/tools/list_changed`
4. Agent discovers own new tool on next `tools/list` call

This enables the Skill Library (evolution stage 2) — agent writes a skill, registers it as an MCP tool, immediately available.

## Skill Library (From Voyager)

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

### SKILL.md Standard (Anthropic, Dec 2025)

Progressive disclosure for managing skill count:

| Tier | Content | Size | When loaded |
|-|-|-|-|
| 1 | Name + description | ~50 tokens | Always (in tool list) |
| 2 | Full instructions | ~500 tokens | On trigger (tool selected) |
| 3 | Scripts/assets | Variable | On demand |

Phase transition at ~50-100 skills: selection accuracy degrades, need hierarchical organization (skill categories, multi-level retrieval).

## Permission Tiers

| Tier | Actions | Examples |
|-|-|-|
| Read-only | Query, search, summarize | Email search, calendar view, spending report |
| Read-write (auto) | Create, modify low-risk items | Create calendar event, draft email (not send) |
| Read-write (approval) | Destructive or irreversible | Send email, transfer money, delete data |

Approval tier uses BullMQ `waitForEvent()` + Telegram callback buttons.
