# Web UI `[proposed]`

The browser cockpit for Cogmo — a single-user, self-hosted dashboard that is both a **chat channel** and the **admin surface** over the existing `Transport` interface. Chat streams token-by-token; every management screen (profiles, memory, skills, coding tasks, MCP, schedules, evolution) drives a `Transport` namespace. Reference mockup: [web-ui/mockups/ledger-dark.html](web-ui/mockups/ledger-dark.html).

The chat-delivery half builds on pieces already marked `[confirmed]` elsewhere: the `StreamingAdapter` contract ([transport/streaming.md](transport/streaming.md)) and the SSE + POST Web UI delivery design ([transport/adapters.md](transport/adapters.md) -> Web UI Delivery). This doc adds the admin API layer, auth, the frontend stack, the monorepo split, and the design system.

## Topology

No second server. The health server (`src/health.ts`, today raw `node:http` on `0.0.0.0:9090`) is promoted in place to a thin hand-rolled router inside the same Inngest connect-mode process — one process, one container, one port.

```
ONE Node process (Inngest connect + agent loop + UI server) on :9090
  GET  /health                         liveness (unchanged)
  POST /api/session                    exchange the derived login token for a session cookie
  DELETE /api/session                  log out (delete the session row)
  ALL  /rpc/*                          oRPC handler over the Transport namespaces
  POST /api/chat                       create a conversation -> { conversationId }
  GET  /api/chat/:cid/stream           SSE: web StreamingAdapter writer + Last-Event-ID replay
  POST /api/chat/:cid                  transport.emit() (inbound user turn)
  *                                    static apps/web/dist via sirv (SPA fallback)
```

## Chat path

Reuses the agent loop verbatim — the orchestrator is never touched.

- **Inbound:** `POST /api/chat/:conversationId` calls `transport.emit()`, exactly as the Direct adapter does. Feeds the existing `handle-message`.
- **Outbound:** a `WebUiAdapter` implements the existing `StreamingAdapter` (`openStream(platformAddress, runId, opts) -> { push, finish, abort }`). It registers the open SSE `ServerResponse` in a process-local map keyed by the per-tab platform address (so tabs never evict one another); `push(event)` writes `id: <seq>\ndata: <json>\n\n` for each `StreamEvent` (`text_delta | thinking_delta | tool_start | tool_result | status`); `finish`/`abort` close it. It joins the same adapters map the `DeliveryRouter` already fans out to, on a `receive: "all"` web session so every tab watching a conversation gets the response.
- **Client reader:** the browser consumes the stream with **`eventsource-client`** (a maintained fetch-based SSE client over the `eventsource-parser` primitive), not native `EventSource` — its custom `fetch` carries cookies/credentials (same-origin sends them by default) and it owns reconnect + `Last-Event-ID`. Each event maps into `assistant-ui`'s `ExternalStoreRuntime` via a stable `convertMessage`.
- **Durability:** Postgres is the substrate — no Redis, no external broker. On `Last-Event-ID`, the server replays missed events reconstructed from persisted `messages` rows, then resumes the live writer.

**Prerequisite (transport-layer change):** the `StreamEvent` union has an `id` on `tool_start` but not on `tool_result`, so `Last-Event-ID` replay needs a **per-turn monotonic event sequence assigned at persist time** to be correct and idempotent. This lands before chat reconnect is load-bearing.

## Admin path

Every management screen drives the existing identity-checked `Transport` namespaces (`conversations, chats, profiles, profileClasses, compartments, models, repos, coding, skills, scheduling, mcp, evolution, boundary`) through **oRPC** — typed RPC, framework-agnostic over `node:http`, with native SSE for live panels and an OpenAPI surface kept internal-only.

- The API is **contract-first**: `webContract` (in `packages/contracts`) is the single source of truth — the server `implement`s it, the SPA derives a fully-typed client from it (no hand-authoring). Procedures are thin wrappers: resolve the authenticated `platformUserHandle` **server-side from the session cookie** (never the request body), call the matching `Transport` method, and on a `Result` error throw the single generic `TRANSPORT_ERROR` carrying the `TransportError` code-discriminated union (with structured fields like `profileRefs`, `limit`/`current`) as `data`; the typed client re-narrows on `data.code`. No business logic in the layer.
- **Live admin panels** (coding-task log tails, status ticks, the evolution feed) use oRPC's SSE event-iterator + the **Client Retry Plugin** for reconnect — one typed mechanism for both request/response and streaming, distinct from the bespoke chat path above.

## Auth and bind

Single-user, lock-the-internet-out — not multi-tenant SaaS auth. The gate is an **ordered strategy chain**, fail-closed: a request with neither a verified upstream identity nor a valid session cookie is rejected, never allowed through (load-bearing under the default all-interfaces bind — an unconfigured "allow" path would be the whole ballgame). The only unauthenticated routes are `GET /health`, the static SPA shell/assets, and `POST /api/session`.

- **Bind.** `WEB_HOST`/`WEB_PORT` are configurable; the web server replaces the health server on `:9090`. Default `WEB_HOST=0.0.0.0` (container convention — required for published ports and orchestrator probes); the security boundary is the publish/proxy layer — `-p 127.0.0.1:9090:9090` (host-loopback only), or no published port plus a `cloudflared` / `tailscale` sidecar reaching the container by service name. App auth is defense-in-depth on top, never the only control. A bare-metal/systemd run with no proxy sets `WEB_HOST=127.0.0.1`.
- **Session — server-side, opaque token.** `POST /api/session` exchanges the login token for an **`httpOnly`, `SameSite=Strict`, `__Host-`-prefixed cookie** carrying a 32-byte CSPRNG opaque token; only its SHA-256 hash lands in `web_sessions`. The cookie carries no claims — the gate hashes it and looks the row up per request, so logout (`DELETE /api/session`) and "log out everywhere" are a row delete and active sessions are listable. Stateless JWT is deliberately avoided: for a first-party app the OWASP guidance, revocation, and `alg`-confusion pitfalls all favor a server-side session.
- **Login token — derived, stored nowhere.** The bootstrap credential is `HKDF(COGMO_MASTER_KEY, "cogmo/web-login-token/v1")` (base64url) — derived, never persisted; the gate recomputes and constant-time-compares it. `cogmo web-token` prints it (deterministic, re-displayable; rotate by bumping the version suffix). No new top-level secret.
- **Trusted identity header.** When fronted by a gateway, a header strategy prepends to the chain — but only when the header's origin is proven, never the plaintext header alone. For Cloudflare Access, verify the signed `Cf-Access-Jwt-Assertion` JWT (against Cloudflare's public keys + the configured AUD), not `Cf-Access-Authenticated-User-Email`. Otherwise accept the identity header (`Tailscale-User-Login`, `X-Forwarded-User`) only from a configured trusted source-IP range or with a proxy-injected shared secret. Plaintext-header trust is never enabled on a publicly-reachable bind: an attacker reaching the port directly (a misconfigured publish, a sibling container on the Docker network) could otherwise spoof it and authenticate as the owner.
- **CSRF — no token.** State-changing requests rely on `SameSite=Strict` + strict `Content-Type: application/json` enforcement (an HTML form can't send it; the server never sniffs a non-JSON body) + an `Origin` / `Sec-Fetch-Site: same-origin` check that rejects when both are absent; safe methods stay side-effect-free. OWASP accepts this token-free combination for same-origin JSON APIs. The Origin / Sec-Fetch-Site check is the real defense; the content-type requirement is the legacy-browser backstop. When uploads land (Phase 2+, oRPC switches to `multipart/form-data` for `File`/`Blob` inputs), the content-type rule relaxes to apply only when `Sec-Fetch-Site` hasn't already proven same-origin — otherwise legitimate same-origin multipart POSTs would 403.
- **Dev cookie.** `__Host-` + `Secure` aren't honored on plain `http://localhost`; `WEB_INSECURE_COOKIES=1` drops them for local http dev only — prod keeps the hardened cookie.
- Passkeys (`SimpleWebAuthn`, one credential row) are the upgrade path for direct exposure.

## Web channel identity

The web channel uses `fixed` identity mode -> the single owner (no per-user resolution needed). Each browser tab mints a per-tab id used as its `platformAddress`, so every tab is its own `channel_session` and can view a different conversation via the sidebar. A tab opens its session with `receive: "all"`; the `DeliveryRouter` resolves every session on a conversation and fans a streamed response out to each, so multiple tabs watching the same conversation all receive it. The per-tab address also keys the SSE connection map, so tabs never evict one another. Abandoned tabs' sessions are reclaimed by the existing idle-timeout lifecycle (and reused on reconnect), so they don't accumulate.

## Monorepo layout

`pnpm-workspace.yaml` becomes `packages: ["apps/*", "packages/*"]` (keep `injectWorkspacePackages: true`). The backend package name stays `cogmo` so `pnpm --filter cogmo deploy` and the Dockerfile resolve unchanged.

```
apps/
  server/                  # the existing backend, internals unmoved (package name stays "cogmo")
    src/web/               # promoted health server: router + sirv + SSE; oRPC handler; session/cookie
    src/transport/adapters/web/   # WebUiAdapter (StreamingAdapter)
  web/                     # the Vite SPA — own tsconfig (DOM, bundler resolution) + own Biome config
    src/{app,chat,shell,screens,components,theme,lib}/
packages/
  contracts/               # StreamEvent, Transport DTOs, the TransportError code union + schema,
                           # and the oRPC `webContract` the server implements and the SPA derives
                           # its typed client from. Ships TS source (exports.import -> ./src) that
                           # tsx/vite transpile and tsup bundles into the server; apps/web imports
                           # the contract type-only, never server runtime code.
```

Docker: one extra build stage (`pnpm --filter web build`) + one `COPY apps/web/dist`; add `apps/web/` to the deny-all `.dockerignore` allow-list. One image, `EXPOSE 9090` stays the only port.

## Tech stack

| Layer | Choice | Why |
|-|-|-|
| Build | Vite 8 (Rolldown) | Static SPA is the default for an auth-gated dashboard with no SEO; Node 24 clears the engine floor. |
| Framework | React 19 SPA, no SSR/RSC | SSR buys nothing on a self-hosted box and fights the SSE + RPC model; inherits the Radix/shadcn polish gravity. |
| Routing / data | TanStack Router + Query (with `@orpc/tanstack-query`) | Typed routes + server-state cache for Transport reads, no second server. |
| Chat runtime | `@assistant-ui/react` `ExternalStoreRuntime` | Zero wire protocol — the `StreamEvent` union flows in unchanged; persistence stays in Postgres. |
| Chat reader | `eventsource-client` (on `eventsource-parser`) | maintained fetch-based SSE client: custom `fetch` (cookies/headers), reconnect + `Last-Event-ID`. |
| Admin API | oRPC (+ Client Retry Plugin) | Typed RPC + native SSE + OpenAPI over raw `node:http`; no backend framework. Internal-only. |
| Components | shadcn/ui copy-in on unified `radix-ui` | Own every line; accessible primitives, total visual control. |
| Styling | Tailwind v4 (`@theme`, OKLCH) | One auditable token file is the design-system source of truth. |
| Tables / lists | TanStack Table v8 + Virtual | Right-sized for skills/MCP/schedule grids and virtualized history/memory. |
| Palette | cmdk | Keyboard-first Cmd+K as the universal action layer. |
| Static serving | sirv | Correct etag/range/SPA-fallback; ~5 KB, the one new runtime dep. |

## Design system — "Ledger"

A warm engineering-document identity that ships **dark by default with a light toggle**, both derived from one OKLCH token set. Product name stays **Cogmo** (cuttlefish mascot); "Ledger" is the theme. Anti-AI-slop by construction: no purple, no gradients, no glassmorphism, no glow.

- **Structure** is carried by hairline rules doing table-like work — zero shadows. Density via ruled tables and exact column alignment on an 8px grid, not cards.
- **Type:** IBM Plex Sans (headings/labels/body) + IBM Plex Mono for all data, ids, scores, the tool card, dates — mono-forward, typeset like a spec.
- **Accent:** one disciplined ink-blue, the single structural accent. Trust state uses a restrained meaning-only palette (verified / hinted / retracted), loud enough to scan dense memory rows, silent everywhere else.
- **Motion:** 120-200ms ease-out on state changes only; the streaming caret is a solid (non-blinking) accent bar marking cursor position.

Dark-theme tokens (light values are the second ramp under `[data-theme="light"]`):

| Token | Value |
|-|-|
| bg / sunk / surface | `oklch(0.20 0.006 75)` / `oklch(0.17 0.006 75)` / `oklch(0.235 0.006 75)` |
| text / muted / faint | `oklch(0.92 0.006 85)` / `oklch(0.66 0.008 80)` / `oklch(0.52 0.008 80)` |
| border / border-strong | `oklch(1 0 0 / 0.10)` / `oklch(1 0 0 / 0.16)` |
| accent / accent-ink / accent-wash | `oklch(0.70 0.13 256)` / `oklch(0.80 0.11 256)` / `oklch(0.70 0.13 256 / 0.14)` |
| verified / hinted / retracted | `oklch(0.74 0.13 150)` / `oklch(0.78 0.13 75)` / `oklch(0.66 0.15 25)` |

The Tailwind v4 `@theme` token file is the canonical source for these values; the committed mockup and this table are visual references, reconciled against `@theme` once it exists.

## Information architecture

One keyboard-first app shell (slim left section-nav + content pane) with a cmdk Cmd+K palette as the universal jump/action layer. The screens consolidate into four sections, never a flat list:

| Section | Screens |
|-|-|
| **CHAT** | Multi-conversation home (history is a sub-list, not a peer screen). Letta-style cockpit: center stream + collapsible right inspector (context-window meter + editable core-memory blocks). |
| **MEMORY** | Hindsight compartment browser, semantic search, trust-tag filters, core-memory blocks. Rendered like a database explorer (dense keyboard-navigable rows + detail drawer), not a card wall. |
| **AGENT** | Profiles editor (base prompt / model / toolset / memory scope / voice / streaming knobs), models/providers, MCP servers (add -> approve-server -> approve/reject-tool), skills library (list / enable / approve deploys / view code). |
| **SYSTEM** | Scheduled tasks, coding tasks (plan approval + worktree/PR status + live SSE log tail), "what it learned" evolution audit + diff, status/observability. |

Setup is a one-time CLI wizard ([setup.md](setup.md)); the web UI does post-setup config only — there is no web onboarding wizard. Every screen renders the `Result` error variant as an explicit inline error row.

**Responsive incl. phone:** the inverted-L shell adapts via Tailwind v4 container queries — the section-nav collapses to a drawer / bottom-tab bar, the right inspector becomes a swipe-up bottom sheet, and dense tables fall back to stacked cards on narrow widths. Images render inline; voice (TTS/STT) is tracked separately, not part of the web cockpit.

## Dependencies

| Component | Module | Depends on |
|-|-|-|
| UI server (promoted health server) | `apps/server/src/web/` | `Transport`, `Transactor`, `AgentStore` |
| `WebUiAdapter` | `apps/server/src/transport/adapters/web/` | `StreamingAdapter`, `DeliveryRouter`, `StreamEvent` |
| oRPC handler | `apps/server/src/web/` | `Transport`, `TransportError` union |
| Per-turn event sequence | `src/llm/types.ts` + persist path | `StreamEvent` |
| `packages/contracts` | shared | `StreamEvent`, Transport DTOs (types only) |

## Testing

Two test surfaces, split by where the code runs:

- **`apps/server/src/web/`** — the HTTP edge, oRPC router, auth gate, session store, and chat routes are unit-tested in Node against ephemeral ports + PGlite: the fail-closed gate, cookie/token derivation, the `web_sessions` store, oRPC `Result` passthrough carrying each `TransportError` code, and a `/health` regression.
- **`apps/web/`** — two tiers, split by extension. `.test.ts` is pure logic with no DOM (the chat stream/history converters) and runs in Node. `.test.tsx` is a component or hook test and runs in **real Chromium via Vitest Browser Mode** (Playwright provider), so accessibility roles, focus, and keyboard handling are exercised the way a browser runs them. The `api` oRPC client is mocked at the module boundary; screens assert their loading / inline-`Result`-error / ready states, and the command palette and the `App` auth boundary are driven through real key and click events. CI runs them in a dedicated web-tests job (Chromium installed there); this Browser-Mode tier is the project's component/hook harness.
