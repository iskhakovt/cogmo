# Integrations

## Channel Adapters `[confirmed]`

Each adapter implements the `AdapterModule` contract (`channelType` + `setup()`) and receives a scoped `Transport`. The channel registry discovers adapters from the DB and starts them at boot. See [transport/adapters.md](transport/adapters.md) for the interface contract. Per-channel:

- **Direct** — event-driven via Inngest (`adapter/direct/inbound`, `adapter/direct/outbound`). Console script (`scripts/console.ts`) for dev interaction.
- [transport/telegram.md](transport/telegram.md) — Telegram (primary): grammY, long polling, DMs only
- [web-ui.md](web-ui.md) — Web UI: single-user browser cockpit (chat channel + admin surface over `Transport`), designed, not yet implemented
- Discord, Slack — future

## MCP Integrations `[proposed]`

See [integrations/mcp.md](integrations/mcp.md) for the full client design (server config, lifecycle, sandboxing, secrets, schema pinning, profile filtering, phasing).

Target third-party servers (priority order):

| Integration | MCP Server | Priority |
|-|-|-|
| Gmail | Community | High |
| Google Calendar | Community | High |
| GitHub | Official | Medium |
| Strava | Community or custom | Medium |
| Banking | Custom (Open Banking API) | Medium |
| Linear | Official | Low (team use) |
| Slack | Official | Low (team use) |

Hindsight stays on the native HTTP client (`MemoryProvider`) — see [integrations/mcp.md → Hindsight](integrations/mcp.md#hindsight-native-client-not-mcp).

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

### Plugin trust tiers `[proposed]`

Plugins (and profiles that use them) operate at different trust levels. The trust tier controls what memory and capabilities are accessible:

| Tier | Who | Memory access | Capability access |
|-|-|-|-|
| **First-party** | Profiles you control (assistant, coder, buddy) | Full (filtered by compartment) | All granted capabilities |
| **Third-party trusted** | Vetted community plugins | Only `trust:any` memories | Restricted capability set |
| **Third-party sandboxed** | Untrusted/new plugins | No memory access | Minimal capabilities (e.g., no network, no filesystem) |

Trust tier is enforced at two layers:
1. **Memory:** tag-based filtering via `trust:*` tags in Hindsight (see `memory.md` → Memory Access Control)
2. **Capabilities:** the WASM bridge exposes different `Service` based on trust tier — a sandboxed plugin simply doesn't have memory or network capabilities available

### WASM maturity (as of 2026)

- WASI Preview 2 stable — HTTP, filesystem, env vars all standardized
- Extism production-ready — used by Helm 4 for plugin sandboxing
- TypeScript-to-WASM works (AssemblyScript, ComponentizeJS) but plugins are ~12MB vs ~100KB for Rust
- **Limitation:** no subprocess spawning from within WASM — this is exactly why the capability bus pattern works

### Plugin tool validation

Plugin tools (WASM, MCP, future execution models) provide JSON Schema for input validation. In-process TypeScript tools use Zod (converted to JSON Schema via `z.toJSONSchema()`). No dynamic JSON Schema → Zod conversion — each environment uses its native validator:

| Environment | Schema source | Validator | Typed handler |
|-|-|-|-|
| In-process (TypeScript) | Zod → JSON Schema | Zod `.parse()` | Yes (`input: T`) |
| Plugin (WASM, future) | JSON Schema directly | ajv or alternative (decide at implementation time) | No (`input: Record<string, unknown>`) |

JSON Schema is the universal contract format. Zod is a convenience, not a requirement. See `agents.md` → Tool Architecture for the full design.

### Phased approach (not a final decision)

1. **Now:** In-process `ToolSpec` with `Service` interface, Zod input validation, direct function calls. Capability interface from day 1 — same contract that WASM plugins will use later.
2. **Phase 2:** MCP client for third-party tools (subprocess isolation, proven pattern, growing ecosystem)
3. **Phase 3+:** Evaluate WASM + capability bus for open-source plugin ecosystem. MCP and WASM can coexist — MCP for power-user integrations that need full OS access, WASM for sandboxed community plugins. `Service` becomes host-imported WASM functions.
