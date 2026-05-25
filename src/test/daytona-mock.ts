/**
 * Record/replay HTTP+WS proxy for the Daytona TypeScript SDK.
 *
 * Mirrors the LLMock-style pattern already used by xAI/Hindsight in this
 * codebase: boot a local HTTP server on a random port, point the SDK at
 * it via `apiUrl`, the mock either forwards to real Daytona (record
 * mode) or replays a previously-captured fixture (replay mode).
 *
 * The Daytona SDK fans calls out across two API surfaces:
 *
 *   - Main API at `apiUrl` — paths under `/sandbox/*`
 *   - Per-sandbox toolbox API at `sandbox.toolboxProxyUrl` returned in
 *     the `create` response — paths under `/process/*`, `/fs/*`,
 *     `/git/*` (plus WS for streaming exec logs)
 *
 * Both surfaces route through this mock. In record mode the mock
 * rewrites the `toolboxProxyUrl` in the `POST /sandbox` response to
 * point at itself (`<mock-url>/toolbox/<sandbox-id>/`), so all
 * subsequent toolbox traffic from the SDK lands here too. The mock
 * stores a {sandbox-id → real toolbox URL} map so it knows where to
 * forward each call upstream. In replay mode the rewrite is already
 * baked into the recorded response — no map needed.
 *
 * Fixture format: one JSON file per scenario, ordered call log. Replay
 * matches each incoming HTTP request against the next unconsumed call
 * with the same `(method, path)` (FIFO within a bucket); WS frames
 * replay verbatim per scenario. Body comparison is intentionally loose
 * — UUIDs, timestamps, and similar non-deterministic fields would
 * otherwise force re-records on every test run.
 */

import { existsSync } from "node:fs";
import { mkdir, readFile, stat, writeFile } from "node:fs/promises";
import { createServer, type IncomingMessage, type Server, type ServerResponse } from "node:http";
import type { Socket } from "node:net";
import { dirname } from "node:path";
import * as R from "remeda";
import WebSocket, { WebSocketServer } from "ws";
import { z } from "zod";
import { logger } from "../logger.js";

const log = logger.child({ component: "test.daytona-mock" });

// --- Fixture schema ─────────────────────────────────────────────────

/** One recorded HTTP request/response pair. */
const HttpCallSchema = z
  .object({
    kind: z.literal("http"),
    method: z.string().min(1),
    /**
     * Path including query string, as the SDK sends it. For toolbox
     * calls this is `/toolbox/<sandbox-id>/process/...`. The
     * `<sandbox-id>` prefix is what the mock injects when rewriting
     * `toolboxProxyUrl`; it does NOT appear in upstream Daytona's
     * actual URL.
     */
    path: z.string().min(1),
    request: z
      .object({
        // Headers excluding hop-by-hop and Authorization (we don't
        // persist secrets in fixtures). Recorded for inspection only;
        // replay doesn't match against them.
        headers: z.record(z.string(), z.string()).optional(),
        bodyJson: z.unknown().optional(),
        bodyText: z.string().optional(),
      })
      .strict(),
    response: z
      .object({
        status: z.number().int(),
        headers: z.record(z.string(), z.string()).optional(),
        bodyJson: z.unknown().optional(),
        bodyText: z.string().optional(),
      })
      .strict(),
  })
  .strict();
type HttpCall = z.infer<typeof HttpCallSchema>;

/** One frame in a WS exchange. */
const WsFrameSchema = z
  .object({
    /** `down` = server→client, `up` = client→server, `close` = WS close. */
    direction: z.enum(["down", "up", "close"]),
    /**
     * Text-frame payload. Mutually exclusive with `bytes`; exactly one
     * of them is set for non-`close` directions. Daytona's
     * `getSessionCommandLogs` and PTY control messages arrive as text;
     * PTY terminal output arrives as binary (see `bytes`).
     */
    text: z.string().optional(),
    /**
     * Binary-frame payload, base64-encoded. Mutually exclusive with
     * `text`. Used for PTY terminal output and for client-side
     * `PtyHandle.sendInput` (the SDK always sends binary, even for
     * string inputs — see `@daytonaio/sdk/esm/PtyHandle.js`).
     */
    bytes: z
      .string()
      .regex(/^[A-Za-z0-9+/]*={0,2}$/, "bytes must be base64")
      .optional(),
    /** WS close code; only present on `close` frames. */
    code: z.number().int().optional(),
    reason: z.string().optional(),
  })
  .strict()
  .refine(
    (f) => !(f.text !== undefined && f.bytes !== undefined),
    "frame must not set both text and bytes",
  );
type WsFrame = z.infer<typeof WsFrameSchema>;

/** One recorded WS connection. Replay emits `down`/`close` frames in order. */
const WsCallSchema = z
  .object({
    kind: z.literal("ws"),
    path: z.string().min(1),
    frames: z.array(WsFrameSchema),
  })
  .strict();
type WsCall = z.infer<typeof WsCallSchema>;

const CallSchema = z.discriminatedUnion("kind", [HttpCallSchema, WsCallSchema]);
type Call = z.infer<typeof CallSchema>;

/**
 * Cursor-first FIFO scan with wrap-around fallback. Walks the fixture
 * starting at `cursor`, wrapping past the end, and returns the first
 * `{ i, call }` whose `call` passes `predicate`. Polling drift (record
 * polls a slow API N times, replay's mock fires once and skips ahead)
 * doesn't strand subsequent unique calls. Mirrors Polly.js's
 * `order: false` fallback.
 *
 * Trade-off: there's no consumed-set — only the cursor — so a fixture
 * with duplicate `(method, path)` entries can re-match an already-played
 * entry after the cursor wraps past the end. Strict FIFO would catch
 * this; we accept it because the alternative (stranded calls when poll
 * counts diverge) is worse for our recorded integration flows. O(n) per
 * lookup is fine at fixture sizes in the low hundreds.
 */
function findWrappedCall<T extends Call>(
  calls: ReadonlyArray<Call>,
  cursor: number,
  predicate: (call: Call) => call is T,
): { i: number; call: T } | undefined {
  return R.pipe(
    R.range(0, calls.length),
    R.map((j) => (cursor + j) % calls.length),
    R.map((i) => ({ i, call: calls[i] })),
    R.find(
      (entry): entry is { i: number; call: T } => entry.call !== undefined && predicate(entry.call),
    ),
  );
}

/**
 * On-disk fixture shape. `recordedAt` is intentionally absent: every
 * re-record would otherwise produce a different timestamp and churn the
 * diff. Load-time consumers derive the recorded-at time from the file's
 * mtime (see `loadFixture`) — same diagnostic value, byte-stable file.
 */
const FixtureSchema = z
  .object({
    scenario: z.string().min(1),
    calls: z.array(CallSchema),
  })
  .strict();
type Fixture = z.infer<typeof FixtureSchema>;

interface LoadedFixture extends Fixture {
  recordedAt: Date;
}

// --- Options ────────────────────────────────────────────────────────

export interface DaytonaMockRecordOptions {
  mode: "record";
  /** Path the fixture will be written to via `endScenario()`. */
  fixturePath: string;
  /** Upstream Daytona main API URL — usually `https://app.daytona.io/api`. */
  upstreamUrl: string;
  /** Real API key forwarded to upstream. Never persisted to disk. */
  upstreamApiKey: string;
  /** Optional organization id, threaded through Authorization. */
  upstreamOrganizationId?: string;
  /**
   * Field-level redactions applied to both request and response body
   * JSON before journaling. Defaults to redacting `organizationId`
   * and `runnerId` — Daytona echoes the operator's actual UUIDs back
   * on every create/get call, and they'd otherwise land in every
   * committed fixture. Extend (don't replace) the defaults to add
   * project-specific PII fields.
   */
  bodyRedactions?: ReadonlyArray<BodyRedaction>;
}

export interface BodyRedaction {
  /** JSON field name to replace at any nesting depth. */
  fieldName: string;
  /** Stable placeholder substituted in for the field's string value. */
  replacement: string;
}

/**
 * Default redactions applied even when `bodyRedactions` is omitted.
 * `organizationId` is the operator's Daytona account UUID; `runnerId`
 * is a Daytona-side infra identifier. Both are returned in nearly
 * every response body and would link a committed fixture to a real
 * account if left in place.
 */
const DEFAULT_BODY_REDACTIONS: ReadonlyArray<BodyRedaction> = [
  { fieldName: "organizationId", replacement: "00000000-0000-0000-0000-000000000000" },
  { fieldName: "runnerId", replacement: "11111111-1111-1111-1111-111111111111" },
];

/**
 * Replace string values at keys named in `rules` anywhere in a
 * JSON-shaped value. Uses `JSON.stringify`'s replacer hook to walk
 * the tree once; safe for the journaling path because the inputs are
 * already `JSON.parse` outputs (no circular refs, no functions /
 * BigInts / Dates that would round-trip incorrectly).
 */
function redactBodyFields(value: unknown, rules: ReadonlyArray<BodyRedaction>): unknown {
  return JSON.parse(
    JSON.stringify(value, (key, val) => {
      const rule = rules.find((r) => r.fieldName === key);
      return rule && typeof val === "string" ? rule.replacement : val;
    }),
  );
}

/**
 * Last-line-of-defense API-key scrub on the serialized fixture string.
 * The HTTP `Authorization` strip and field-name `BodyRedaction` cover
 * the common shapes; this catches keys nested at arbitrary depth
 * (`exec` env, `git.password`, etc.). Coverage is explicit — extend
 * when a new provider lands; tokens without a recognizable prefix
 * need field-name masking instead.
 */
const KNOWN_API_KEY_PATTERNS: ReadonlyArray<{ pattern: RegExp; replacement: string }> = [
  { pattern: /sk-ant-api03-[A-Za-z0-9_-]{60,}/g, replacement: "sk-ant-api03-REDACTED" },
  { pattern: /\b(gh[pousr]|github_pat)_[A-Za-z0-9_]{20,}\b/g, replacement: "$1_REDACTED" },
  // Order matters: the Anthropic `sk-ant-api03-` form is more specific
  // and runs first so it doesn't get caught by this generic `sk-` rule.
  { pattern: /\bsk-(?:proj-|svcacct-|admin-)?[A-Za-z0-9_-]{32,}\b/g, replacement: "sk-REDACTED" },
];

/**
 * Strip runtime-random IDs from request paths so record / replay match
 * regardless of what task/sandbox/session IDs Postgres or Daytona
 * generated this run. Covers two shapes:
 *   - full UUIDs (sandbox / command / file IDs from Daytona responses)
 *   - cogmo session-ID prefix `cogmo-<8hex>-<3hex>` where the hex run is
 *     a 12-char slice of a task UUID (DaytonaSandboxSession.execStreaming)
 * The fixture stores the original path; matching compares normalized.
 */
const UUID_RE = /[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/gi;
// Session ID = `cogmo-<12-char-task-prefix>-<random-suffix>`. The suffix
// is randomUUID() in production and `<TEST_RUN_ID>-<seq>` in tests; seq
// drifts between record and replay because the call order doesn't always
// line up byte-for-byte. Match the whole session ID through the suffix.
const COGMO_SESSION_ID_RE = /cogmo-[0-9a-f]{8}-[0-9a-f]{3}-[^/?]+/gi;
function normalizePath(
  path: string,
  extra: ReadonlyArray<{ pattern: RegExp; replacement: string }> = [],
): string {
  let out = path.replace(UUID_RE, "<UUID>").replace(COGMO_SESSION_ID_RE, "cogmo-<SESSION>");
  for (const { pattern, replacement } of extra) out = out.replace(pattern, replacement);
  return out;
}

const BODY_BOUND_HEADERS = new Set([
  "content-length",
  "transfer-encoding",
  "content-encoding",
  "connection",
  "keep-alive",
  "date",
  "etag",
]);

function redactSecrets(input: string): string {
  let out = input;
  for (const { pattern, replacement } of KNOWN_API_KEY_PATTERNS) {
    out = out.replace(pattern, replacement);
  }
  return out;
}

/**
 * Normalize a WS message payload to a Buffer. `ws` delivers messages
 * as `Buffer`, `ArrayBuffer`, or `Buffer[]` (when `binaryType` is
 * `nodebuffer` / `arraybuffer` / `fragments`); journaling needs one
 * concrete shape so the base64 encoding is stable across deliveries.
 */
function toBuffer(data: WebSocket.RawData): Buffer {
  if (Buffer.isBuffer(data)) return data;
  if (data instanceof ArrayBuffer) return Buffer.from(data);
  return Buffer.concat(data);
}

/**
 * Walk a JSON body and replace every `toolboxProxyUrl` (alongside an
 * `id`) with the placeholder, populating `toolboxUpstreams` so the
 * record-mode forwarder can resolve subsequent toolbox calls.
 */
function rewriteToolboxProxyUrls(body: unknown, toolboxUpstreams: Map<string, string>): unknown {
  if (Array.isArray(body)) {
    for (const item of body) rewriteToolboxProxyUrls(item, toolboxUpstreams);
    return body;
  }
  if (typeof body !== "object" || body === null) return body;
  const obj = body as Record<string, unknown>;
  const id = obj.id;
  const originalToolbox = obj.toolboxProxyUrl;
  if (typeof id === "string" && typeof originalToolbox === "string") {
    toolboxUpstreams.set(id, originalToolbox);
    obj.toolboxProxyUrl = `${MOCK_URL_PLACEHOLDER}/toolbox`;
  }
  for (const value of Object.values(obj)) rewriteToolboxProxyUrls(value, toolboxUpstreams);
  return obj;
}

export interface DaytonaMockReplayOptions {
  mode: "replay";
  /** Path to read the fixture from. */
  fixturePath: string;
  /**
   * Per-path fault injection. When an incoming request matches a
   * configured pattern, the mock injects the configured failure mode
   * instead of consulting the fixture cursor. Used by wedge-regression
   * tests to drive a real `@daytonaio/sdk` client + real `ws`
   * WebSocket into a hung state without a recorded "hang" fixture
   * (Daytona doesn't emit a recordable hang — it's an upstream
   * transport failure mode we model directly).
   *
   * `ws-hold-open`: accept the WS upgrade, send nothing, never close.
   * The matching WS path bypasses the fixture cursor entirely, so a
   * fixture for *other* calls keeps its FIFO order intact.
   */
  faults?: ReadonlyArray<{ wsPathPattern: RegExp; kind: "ws-hold-open" }>;
  /**
   * Per-test path normalizations applied to both incoming and recorded
   * paths before matching. Use this to strip test-specific random
   * tokens (e.g. `skill-author-\d+` sequence numbers) so call order can
   * drift between record and replay without breaking exact-path match.
   * The mock always strips full UUIDs and the `cogmo-<sandboxShort>-`
   * session prefix; tests add tokens beyond those defaults.
   */
  pathNormalizations?: ReadonlyArray<{ pattern: RegExp; replacement: string }>;
}

export type DaytonaMockOptions = DaytonaMockRecordOptions | DaytonaMockReplayOptions;

// --- Implementation ─────────────────────────────────────────────────

const TOOLBOX_PATH_PREFIX = "/toolbox/";

/**
 * Placeholder host written into the fixture in place of the mock's
 * recording-time port. Substituted with the live mock URL on replay
 * so fixtures stay portable across processes/machines (the port is
 * always random).
 */
const MOCK_URL_PLACEHOLDER = "http://__daytona_mock__";

/**
 * Hop-by-hop / connection-scoped HTTP headers that MUST NOT be
 * forwarded to upstream (or accepted from upstream as-is). Per
 * RFC 2616 §13.5.1 plus `host` (connection-scoped routing target).
 * `content-length` is hop-by-hop in practice — Node's `fetch()`
 * recomputes it from the Buffer body. `transfer-encoding: chunked`
 * is the one that bites — undici rejects it with
 * `InvalidArgumentError: invalid transfer-encoding header` when
 * supplied on the input request. Shared between the HTTP forwarder
 * and the WS upgrade so the two paths can't drift.
 */
const HOP_BY_HOP_HEADERS = new Set([
  "host",
  "connection",
  "content-length",
  "transfer-encoding",
  "keep-alive",
  "proxy-authenticate",
  "proxy-authorization",
  "te",
  "trailers",
  "upgrade",
]);

interface InFlightScenario {
  name: string;
  calls: Call[];
}

interface ReplayState {
  fixture: LoadedFixture;
  /**
   * Index of the next call to match. Advances on each successful
   * HTTP or WS match — they share one cursor. Order-fragile: replay
   * must invoke calls in the same sequence as recording, including
   * HTTP/WS interleaving. A WS upgrade with N HTTP calls recorded
   * after it can't be matched first; the cursor would skip past
   * those HTTP calls and they'd 503 on the next replay. Today the
   * sole scenario interleaves deterministically, so this is fine —
   * promote to per-kind cursors when a second scenario needs a
   * different order.
   */
  cursor: number;
}

export class DaytonaMock {
  readonly url: string;
  #server: Server;
  #wss: WebSocketServer;
  #opts: DaytonaMockOptions;
  /** Record mode: in-flight scenario being captured. */
  #scenario: InFlightScenario | null = null;
  /** Record mode: { sandbox-id → real toolbox base URL } so toolbox forwards work. */
  #toolboxUpstreams = new Map<string, string>();
  /**
   * Record mode: in-flight WS-journaling promises. Each entry resolves
   * when the corresponding upstream WS closes AND its frames have been
   * pushed into `#scenario.calls`. `endScenario()` awaits the full set
   * so a fixture write after the SDK call resolves but before upstream
   * close lands still captures the WS frames.
   */
  #pendingWsJournals = new Set<Promise<void>>();
  /** Replay mode: loaded fixture + cursor. */
  #replay: ReplayState | null = null;

  private constructor(
    opts: DaytonaMockOptions,
    server: Server,
    wss: WebSocketServer,
    port: number,
  ) {
    this.#opts = opts;
    this.#server = server;
    this.#wss = wss;
    this.url = `http://127.0.0.1:${port}`;
    this.#bodyRedactions =
      opts.mode === "record" ? (opts.bodyRedactions ?? DEFAULT_BODY_REDACTIONS) : [];
  }

  /**
   * Field-level redactions applied to journaled request + response
   * body JSON. Populated from `bodyRedactions` in record mode; empty
   * in replay (no journaling). Recorded fixtures should be safe to
   * commit because of this — the live operator's `organizationId`,
   * `runnerId`, and any other configured fields are substituted with
   * stable placeholders before bytes hit disk.
   */
  #bodyRedactions: ReadonlyArray<BodyRedaction>;

  static async create(opts: DaytonaMockOptions): Promise<DaytonaMock> {
    const server = createServer();
    // noServer mode — we wire `upgrade` events to it manually so the
    // same HTTP server serves both REST and WS without splitting ports.
    const wss = new WebSocketServer({ noServer: true });
    await new Promise<void>((resolve, reject) => {
      server.once("error", reject);
      server.listen(0, "127.0.0.1", () => resolve());
    });
    const address = server.address();
    if (!address || typeof address === "string") {
      throw new Error("DaytonaMock: server.address() returned unexpected shape");
    }
    const mock = new DaytonaMock(opts, server, wss, address.port);
    if (opts.mode === "replay") {
      const [raw, statRes] = await Promise.all([
        readFile(opts.fixturePath, "utf8"),
        stat(opts.fixturePath),
      ]);
      const parsed = FixtureSchema.parse(JSON.parse(raw));
      const fixture: LoadedFixture = { ...parsed, recordedAt: statRes.mtime };
      mock.#replay = { fixture, cursor: 0 };
    }
    server.on("request", (req, res) => {
      mock.#handleRequest(req, res).catch((err: Error) => {
        log.error({ err: err.message, path: req.url }, "request handler failed");
        if (!res.headersSent) {
          res.statusCode = 500;
          res.setHeader("content-type", "text/plain");
          res.end(`daytona-mock internal error: ${err.message}`);
        }
      });
    });
    server.on("upgrade", (req, socket, head) => {
      wss.handleUpgrade(req, socket as Socket, head, (ws) => {
        mock.#handleWs(ws, req.url ?? "/", req.headers).catch((err: Error) => {
          log.error({ err: err.message, path: req.url }, "ws handler failed");
          ws.close(1011, "internal");
        });
      });
    });
    return mock;
  }

  /**
   * Open a fresh scenario buffer. Calls between `beginScenario` and
   * `endScenario` accumulate; the fixture is persisted on `endScenario`.
   * Record mode only — no-op in replay.
   */
  beginScenario(name: string): void {
    if (this.#opts.mode !== "record") return;
    this.#scenario = { name, calls: [] };
    this.#toolboxUpstreams.clear();
  }

  /** Persist the current scenario buffer to `fixturePath`. */
  async endScenario(): Promise<void> {
    if (this.#opts.mode !== "record" || this.#scenario === null) return;
    // Wait for every in-flight upstream WS connection to emit close
    // (or error) and flush its frames into `#scenario.calls` before
    // we serialize. The SDK's WS callback can resolve before the
    // upstream close arrives at the mock; without this await, the
    // fixture would miss those frames.
    if (this.#pendingWsJournals.size > 0) {
      await Promise.allSettled([...this.#pendingWsJournals]);
    }
    const fixture: Fixture = {
      scenario: this.#scenario.name,
      calls: this.#scenario.calls,
    };
    const dir = dirname(this.#opts.fixturePath);
    if (!existsSync(dir)) await mkdir(dir, { recursive: true });
    const serialized = redactSecrets(`${JSON.stringify(fixture, null, 2)}\n`);
    await writeFile(this.#opts.fixturePath, serialized, "utf8");
    log.info({ path: this.#opts.fixturePath, callCount: fixture.calls.length }, "fixture written");
    this.#scenario = null;
  }

  async stop(): Promise<void> {
    this.#wss.close();
    await new Promise<void>((resolve, reject) => {
      this.#server.close((err) => (err ? reject(err) : resolve()));
    });
  }

  /**
   * Handle a WS upgrade. Record mode: open the corresponding upstream
   * WS, journal frames in both directions, forward. Replay mode: walk
   * the fixture forward, find the next unconsumed `ws` call whose path
   * matches, emit its `down`/`close` frames in order. Client→server
   * frames in replay are accepted-and-ignored — the
   * `getSessionCommandLogs` contract is server-stream-only.
   */
  async #handleWs(ws: WebSocket, path: string, headers: IncomingMessage["headers"]): Promise<void> {
    if (this.#opts.mode === "record") {
      await this.#recordWs(ws, path, headers);
      return;
    }
    // Fault injection: if a configured `ws-hold-open` pattern matches,
    // accept the upgrade and do nothing. The SDK's `getSessionCommandLogs`
    // Promise hangs until something on the client side tears the WS
    // down — which is exactly what production looked like during the
    // wedge incident. The fixture cursor is NOT advanced, so any
    // subsequent HTTP call (e.g. the cleanup `DELETE` triggered by
    // `ExecTimeoutError`) still matches its fixture entry in FIFO
    // order.
    const fault = this.#opts.faults?.find((f) => f.wsPathPattern.test(path));
    if (fault?.kind === "ws-hold-open") {
      log.debug({ path }, "ws-hold-open fault: accepting upgrade, no frames, no close");
      // Drop the client-side socket reference so GC doesn't pre-empt
      // the hold — the WS stays alive until either the client or the
      // server tears it down. The test driver tears it down via
      // `mock.stop()`.
      return;
    }
    this.#replayWs(ws, path);
  }

  async #recordWs(
    ws: WebSocket,
    path: string,
    incomingHeaders: IncomingMessage["headers"],
  ): Promise<void> {
    if (this.#opts.mode !== "record") return;
    const upstreamUrl = this.#resolveWsUpstreamUrl(path);
    if (!upstreamUrl) {
      ws.close(1011, "no upstream for path");
      return;
    }
    // Forward the SDK's full header set to the upstream WS. Stripping
    // hop-by-hop + WS-upgrade headers (the new connection sets its own)
    // and overwriting `authorization` with our upstream key. The
    // `x-daytona-*` SDK metadata headers ride along — Daytona's
    // toolbox-WS proxy gates on those.
    const wsHeaders: Record<string, string> = {};
    for (const [k, v] of Object.entries(incomingHeaders)) {
      if (typeof v !== "string") continue;
      const lower = k.toLowerCase();
      // Strip hop-by-hop + sec-websocket-* (the new upstream WS sets
      // its own upgrade handshake headers). Shared HOP_BY_HOP set
      // keeps this in lockstep with the HTTP forwarder.
      if (HOP_BY_HOP_HEADERS.has(lower) || lower.startsWith("sec-websocket-")) {
        continue;
      }
      wsHeaders[k] = v;
    }
    wsHeaders.authorization = `Bearer ${this.#opts.upstreamApiKey}`;
    log.debug({ path, upstreamUrl }, "ws upgrade");
    const frames: WsFrame[] = [];
    const upstream = new WebSocket(upstreamUrl, { headers: wsHeaders });

    // Track journal completion so `endScenario()` can wait for the
    // upstream close to land + frames to flush before writing the
    // fixture. Without this, the SDK's WS promise can resolve (its
    // client-side close fires when we forward the upstream close) and
    // the test can call `endScenario()` while we're still mid-journal.
    let resolveJournaled: () => void = () => {};
    const journaled = new Promise<void>((resolve) => {
      resolveJournaled = resolve;
    });
    this.#pendingWsJournals.add(journaled);
    journaled.finally(() => this.#pendingWsJournals.delete(journaled));

    // Server→client direction. Forward + journal. Binary frames go
    // through `bytes` (base64) so a PTY's raw terminal output survives
    // the round-trip — `data.toString()` would UTF-8-decode it and
    // mangle any byte sequence that isn't valid UTF-8.
    upstream.on("message", (data: WebSocket.RawData, isBinary: boolean) => {
      const buf = toBuffer(data);
      frames.push(
        isBinary
          ? { direction: "down", bytes: buf.toString("base64") }
          : { direction: "down", text: buf.toString("utf8") },
      );
      ws.send(data, { binary: isBinary });
    });
    upstream.on("close", (code, reason) => {
      frames.push({ direction: "close", code, reason: reason.toString() });
      this.#scenario?.calls.push({ kind: "ws", path, frames });
      resolveJournaled();
      try {
        ws.close(code, reason);
      } catch {
        // ws may already be closed
      }
    });
    upstream.on("error", (err) => {
      log.warn({ err: err.message, upstreamUrl }, "upstream WS errored during record");
      this.#scenario?.calls.push({ kind: "ws", path, frames });
      resolveJournaled();
      try {
        ws.close(1011, "upstream error");
      } catch {
        // ws may already be closed
      }
    });

    // Client→server direction. Forward + journal. Binary frames go
    // through `bytes` — `PtyHandle.sendInput` always sends binary, even
    // for string inputs (the SDK runs `TextEncoder().encode(data)`
    // before `ws.send`).
    ws.on("message", (data: WebSocket.RawData, isBinary: boolean) => {
      const buf = toBuffer(data);
      frames.push(
        isBinary
          ? { direction: "up", bytes: buf.toString("base64") }
          : { direction: "up", text: buf.toString("utf8") },
      );
      if (upstream.readyState === WebSocket.OPEN) {
        upstream.send(data, { binary: isBinary });
      }
    });
    ws.on("close", (code) => {
      if (upstream.readyState === WebSocket.OPEN) {
        upstream.close(code);
      }
    });
  }

  #replayWs(ws: WebSocket, path: string): void {
    const replay = this.#replay;
    if (!replay) {
      ws.close(1011, "replay state not initialized");
      return;
    }
    const extra = this.#opts.mode === "replay" ? (this.#opts.pathNormalizations ?? []) : [];
    const normalizedIncoming = normalizePath(path, extra);
    const match = findWrappedCall(
      replay.fixture.calls,
      replay.cursor,
      (call): call is WsCall =>
        call.kind === "ws" && normalizePath(call.path, extra) === normalizedIncoming,
    );
    if (!match) {
      log.warn({ path, cursor: replay.cursor }, "no WS fixture match");
      ws.close(1011, "no fixture match");
      return;
    }
    replay.cursor = match.i + 1;
    this.#emitFrames(ws, match.call.frames);
  }

  /**
   * Emit recorded server→client frames in order. Schedules via
   * `queueMicrotask` so each frame surfaces as its own `message` event
   * on the client side, matching the per-chunk delivery the SDK sees
   * over a real Daytona toolbox WS. `close` frames terminate the
   * connection with the recorded code/reason. Binary frames (`bytes`)
   * are emitted as binary so consumers seeing `isBinary === true` on
   * replay match the live-record signal.
   */
  #emitFrames(ws: WebSocket, frames: ReadonlyArray<WsFrame>): void {
    let i = 0;
    const next = (): void => {
      while (i < frames.length) {
        const frame = frames[i++];
        if (!frame) continue;
        if (frame.direction === "up") continue; // client→server frames are not replayed
        if (frame.direction === "down") {
          if (ws.readyState !== WebSocket.OPEN) return;
          if (frame.bytes !== undefined) {
            ws.send(Buffer.from(frame.bytes, "base64"), { binary: true });
            queueMicrotask(next);
            return;
          }
          if (frame.text !== undefined) {
            ws.send(frame.text);
            queueMicrotask(next);
            return;
          }
          // `down` with neither text nor bytes is a noise frame; skip.
          continue;
        }
        if (frame.direction === "close") {
          try {
            ws.close(frame.code ?? 1000, frame.reason ?? "");
          } catch {
            // already closed
          }
          return;
        }
      }
      // Fixture ended without an explicit close — close cleanly.
      try {
        ws.close(1000);
      } catch {
        // already closed
      }
    };
    queueMicrotask(next);
  }

  #resolveWsUpstreamUrl(path: string): string | null {
    if (this.#opts.mode !== "record") return null;
    if (!path.startsWith(TOOLBOX_PATH_PREFIX)) return null;
    const rest = path.slice(TOOLBOX_PATH_PREFIX.length);
    const slash = rest.indexOf("/");
    if (slash < 0) return null;
    const sandboxId = rest.slice(0, slash);
    const subPath = rest.slice(slash);
    const base = this.#toolboxUpstreams.get(sandboxId);
    if (!base) return null;
    // Toolbox base is `https://...`; flip the scheme to `wss://` for WS.
    // Sandbox-id is re-injected for the same reason as `#resolveUpstreamUrl`.
    const wsBase = base.replace(/^http(s?):/, (_, s) => `ws${s}:`).replace(/\/$/, "");
    return `${wsBase}/${sandboxId}${subPath}`;
  }

  async #handleRequest(req: IncomingMessage, res: ServerResponse): Promise<void> {
    const method = req.method ?? "GET";
    const path = req.url ?? "/";

    if (this.#opts.mode === "record") {
      const bodyBuf = await this.#readBody(req);
      await this.#recordAndForward(method, path, req.headers, bodyBuf, res);
    } else {
      // Replay matches by `(method, path)` only — body is not consumed.
      this.#replayMatch(method, path, res);
    }
  }

  async #recordAndForward(
    method: string,
    path: string,
    headers: IncomingMessage["headers"],
    body: Buffer,
    res: ServerResponse,
  ): Promise<void> {
    // Narrow `#opts` to the record variant at the top so downstream
    // accesses to `upstreamApiKey` / `upstreamOrganizationId`
    // typecheck without repeated `mode === "record"` guards.
    if (this.#opts.mode !== "record") {
      throw new Error("invariant: #recordAndForward called outside record mode");
    }
    const opts = this.#opts;

    const upstreamUrl = this.#resolveUpstreamUrl(path);
    if (!upstreamUrl) {
      res.statusCode = 502;
      res.end(`daytona-mock: no upstream for path ${path}`);
      return;
    }
    const upstreamHeaders = this.#prepareUpstreamHeaders(headers);
    // Authorization is added only to the OUTBOUND request; stripped
    // from the fixture journal below so real keys never land on disk.
    // Lowercase key overwrites the SDK's incoming `authorization`
    // rather than emitting a duplicate — Node's `fetch()` builds
    // Headers via `append`, joining same-name duplicates with a
    // comma and malforming the Bearer token.
    upstreamHeaders.authorization = `Bearer ${opts.upstreamApiKey}`;
    if (opts.upstreamOrganizationId) {
      upstreamHeaders["x-daytona-organization-id"] = opts.upstreamOrganizationId;
    }

    log.debug({ method, upstreamUrl, bodyBytes: body.length }, "forward");
    const upstreamResp = await fetch(upstreamUrl, {
      method,
      headers: upstreamHeaders,
      // `as unknown as BodyInit`: Node Buffer is structurally a
      // Uint8Array (and BodyInit accepts Uint8Array), but
      // `@types/node`'s Buffer doesn't unify with the DOM-style
      // BodyInit union from undici's fetch types. Cast forces the
      // structurally-correct value through.
      ...(body.length > 0 && { body: body as unknown as BodyInit }),
    });
    log.debug({ status: upstreamResp.status, upstreamUrl }, "upstream response");
    const respHeaders: Record<string, string> = {};
    upstreamResp.headers.forEach((v, k) => {
      respHeaders[k] = v;
    });
    const respBodyBuf = Buffer.from(await upstreamResp.arrayBuffer());
    // Mutable so we can rewrite toolboxProxyUrl below; the rewritten
    // bytes are what we BOTH send back to the SDK AND persist to the
    // fixture, so replay sees the same `toolboxProxyUrl` as the live
    // record run did.
    let respBodyForClient = respBodyBuf;
    let respBodyJsonForFixture: unknown;
    let respBodyTextForFixture: string | undefined;

    const contentType = respHeaders["content-type"] ?? "";
    if (contentType.includes("application/json") && respBodyBuf.length > 0) {
      try {
        const parsed = JSON.parse(respBodyBuf.toString("utf8")) as unknown;
        // Rewrite first so the {sandbox-id → real toolbox} map gets
        // populated for downstream toolbox-routing in the same record
        // session. The rewrite uses the placeholder host so the
        // fixture stays portable across mock-port spawns. Runs on
        // every response (not just POST /sandbox) — `sandbox.resume`
        // goes through `daytona.get(sandboxId)` and the SDK rebinds
        // its axios baseURL from the GET response too.
        const rewrittenForFixture = rewriteToolboxProxyUrls(parsed, this.#toolboxUpstreams);
        // For the SDK in this record session, substitute the
        // placeholder with the live mock URL so subsequent toolbox
        // calls actually resolve to us.
        const rewrittenForClient = this.#materializePlaceholders(
          JSON.parse(JSON.stringify(rewrittenForFixture)),
        );
        respBodyJsonForFixture = redactBodyFields(rewrittenForFixture, this.#bodyRedactions);
        respBodyForClient = Buffer.from(JSON.stringify(rewrittenForClient));
        // Recompute content-length so the proxied response doesn't
        // mismatch its body bytes after rewriting.
        respHeaders["content-length"] = String(respBodyForClient.length);
      } catch {
        respBodyTextForFixture = respBodyBuf.toString("utf8");
      }
    } else if (respBodyBuf.length > 0) {
      respBodyTextForFixture = respBodyBuf.toString("utf8");
    }

    // Journal the call. Authorization is stripped (never persist real
    // keys to disk). Hop-by-hop and connection-scoped headers (host,
    // content-length, connection, accept-encoding) are also stripped:
    // they're not used for matching, change on every record (random
    // mock port, varying body sizes), and would churn the diff on
    // re-records. We keep the SDK metadata (`user-agent`,
    // `x-daytona-*`) + the content-type so the recorded shape stays
    // descriptive.
    const reqHeadersForFixture: Record<string, string> = {};
    for (const [k, v] of Object.entries(headers)) {
      if (typeof v !== "string") continue;
      const lower = k.toLowerCase();
      if (
        lower === "authorization" ||
        lower === "host" ||
        lower === "content-length" ||
        lower === "connection" ||
        lower === "accept-encoding"
      ) {
        continue;
      }
      reqHeadersForFixture[k] = v;
    }
    let reqBodyJson: unknown;
    let reqBodyText: string | undefined;
    if (body.length > 0) {
      const reqContentType = headers["content-type"];
      if (typeof reqContentType === "string" && reqContentType.includes("application/json")) {
        try {
          reqBodyJson = redactBodyFields(
            JSON.parse(body.toString("utf8")) as unknown,
            this.#bodyRedactions,
          );
        } catch {
          reqBodyText = body.toString("utf8");
        }
      } else {
        reqBodyText = body.toString("utf8");
      }
    }
    const call: HttpCall = {
      kind: "http",
      method,
      path,
      request: {
        headers: reqHeadersForFixture,
        ...(reqBodyJson !== undefined && { bodyJson: reqBodyJson }),
        ...(reqBodyText !== undefined && { bodyText: reqBodyText }),
      },
      response: {
        status: upstreamResp.status,
        headers: respHeaders,
        ...(respBodyJsonForFixture !== undefined && { bodyJson: respBodyJsonForFixture }),
        ...(respBodyTextForFixture !== undefined && { bodyText: respBodyTextForFixture }),
      },
    };
    this.#scenario?.calls.push(call);

    // Send the rewritten response back to the SDK.
    res.statusCode = upstreamResp.status;
    for (const [k, v] of Object.entries(respHeaders)) {
      res.setHeader(k, v);
    }
    res.end(respBodyForClient);
  }

  /**
   * Match an incoming HTTP request to the next unconsumed call in
   * `#replay.fixture.calls`. Match key is `(method, path)` only —
   * the request body is intentionally NOT part of the match. Strict
   * body comparison would force re-records on every UUID/timestamp;
   * we rely on `(method, path)` + FIFO ordering to keep replays
   * deterministic. See the `ReplayState.cursor` docstring for the
   * HTTP/WS interleaving caveat.
   */
  #replayMatch(method: string, path: string, res: ServerResponse): void {
    const replay = this.#replay;
    if (!replay) {
      res.statusCode = 500;
      res.end("daytona-mock: replay state not initialized");
      return;
    }
    const extra = this.#opts.mode === "replay" ? (this.#opts.pathNormalizations ?? []) : [];
    const normalizedIncoming = normalizePath(path, extra);
    const match = findWrappedCall(
      replay.fixture.calls,
      replay.cursor,
      (call): call is HttpCall =>
        call.kind === "http" &&
        call.method === method &&
        normalizePath(call.path, extra) === normalizedIncoming,
    );
    if (!match) {
      log.warn({ method, path, cursor: replay.cursor }, "no fixture match");
      res.statusCode = 503;
      res.setHeader("content-type", "text/plain");
      res.end(
        `daytona-mock replay: no fixture match for ${method} ${path} after cursor ${replay.cursor}. Re-record via \`pnpm test:record\` with DAYTONA_API_KEY set.`,
      );
      return;
    }
    replay.cursor = match.i + 1;
    res.statusCode = match.call.response.status;
    for (const [k, v] of Object.entries(match.call.response.headers ?? {})) {
      // Skip headers Node computes from the actual body; recorded values
      // are bound to original bytes and mismatch ours after body
      // materialization, which axios sees as premature stream close.
      if (BODY_BOUND_HEADERS.has(k.toLowerCase())) continue;
      res.setHeader(k, v);
    }
    if (match.call.response.bodyJson !== undefined) {
      const materialized = this.#materializePlaceholders(
        JSON.parse(JSON.stringify(match.call.response.bodyJson)),
      );
      res.end(JSON.stringify(materialized));
    } else if (match.call.response.bodyText !== undefined) {
      const text = match.call.response.bodyText.includes(MOCK_URL_PLACEHOLDER)
        ? match.call.response.bodyText.replaceAll(MOCK_URL_PLACEHOLDER, this.url)
        : match.call.response.bodyText;
      res.end(text);
    } else {
      res.end();
    }
    log.debug(
      { method, path, status: match.call.response.status, cursor: replay.cursor },
      "replay match",
    );
  }

  /**
   * Determine the upstream URL for an incoming request:
   *  - `/sandbox/*` → main Daytona API
   *  - `/toolbox/<id>/<rest>` → that sandbox's per-toolbox URL (looked
   *    up in `#toolboxUpstreams`, populated when we rewrote the create
   *    response)
   */
  #resolveUpstreamUrl(path: string): string | null {
    if (this.#opts.mode !== "record") return null;
    if (path.startsWith(TOOLBOX_PATH_PREFIX)) {
      const rest = path.slice(TOOLBOX_PATH_PREFIX.length);
      const slash = rest.indexOf("/");
      if (slash < 0) return null;
      const sandboxId = rest.slice(0, slash);
      const subPath = rest.slice(slash); // includes leading '/'
      const base = this.#toolboxUpstreams.get(sandboxId);
      if (!base) return null;
      // Re-inject sandbox-id into the upstream URL. Daytona's real
      // `toolboxProxyUrl` is bare (`https://proxy.../toolbox`); the
      // SDK appends `/<sandbox-id>` to build per-sandbox paths.
      // Our rewrite mirrors that, so the SDK sends `/toolbox/<id>/...`
      // to the mock — we strip `/toolbox/<id>` off, look up the bare
      // upstream base, and add the id back.
      return `${base.replace(/\/$/, "")}/${sandboxId}${subPath}`;
    }
    // Main API. Strip leading '/' before joining so we don't end up
    // with a double slash that some upstreams 308 on.
    return `${this.#opts.upstreamUrl.replace(/\/$/, "")}${path}`;
  }

  #prepareUpstreamHeaders(headers: IncomingMessage["headers"]): Record<string, string> {
    const out: Record<string, string> = {};
    for (const [k, v] of Object.entries(headers)) {
      if (typeof v !== "string") continue;
      if (HOP_BY_HOP_HEADERS.has(k.toLowerCase())) continue;
      out[k] = v;
    }
    return out;
  }

  /**
   * Walk a JSON body and replace the placeholder host with the
   * mock's current URL. Recursive, in-place. Returns the same
   * reference; caller serializes downstream.
   */
  #materializePlaceholders(value: unknown): unknown {
    if (typeof value === "string") {
      return value.includes(MOCK_URL_PLACEHOLDER)
        ? value.replaceAll(MOCK_URL_PLACEHOLDER, this.url)
        : value;
    }
    if (Array.isArray(value)) {
      for (let i = 0; i < value.length; i++) {
        value[i] = this.#materializePlaceholders(value[i]);
      }
      return value;
    }
    if (typeof value === "object" && value !== null) {
      const obj = value as Record<string, unknown>;
      for (const k of Object.keys(obj)) {
        obj[k] = this.#materializePlaceholders(obj[k]);
      }
      return obj;
    }
    return value;
  }

  async #readBody(req: IncomingMessage): Promise<Buffer> {
    const chunks: Buffer[] = [];
    for await (const chunk of req) {
      chunks.push(typeof chunk === "string" ? Buffer.from(chunk) : (chunk as Buffer));
    }
    return Buffer.concat(chunks);
  }
}
