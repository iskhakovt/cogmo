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
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { createServer, type IncomingMessage, type Server, type ServerResponse } from "node:http";
import type { Socket } from "node:net";
import { dirname } from "node:path";
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
    /** Frame payload. Empty for `close`. Daytona log frames are text. */
    text: z.string().optional(),
    /** WS close code; only present on `close` frames. */
    code: z.number().int().optional(),
    reason: z.string().optional(),
  })
  .strict();
type WsFrame = z.infer<typeof WsFrameSchema>;

/** One recorded WS connection. Replay emits `down`/`close` frames in order. */
const WsCallSchema = z
  .object({
    kind: z.literal("ws"),
    path: z.string().min(1),
    frames: z.array(WsFrameSchema),
  })
  .strict();

const CallSchema = z.discriminatedUnion("kind", [HttpCallSchema, WsCallSchema]);
type Call = z.infer<typeof CallSchema>;

const FixtureSchema = z
  .object({
    scenario: z.string().min(1),
    recordedAt: z.string().datetime(),
    calls: z.array(CallSchema),
  })
  .strict();
type Fixture = z.infer<typeof FixtureSchema>;

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
}

export interface DaytonaMockReplayOptions {
  mode: "replay";
  /** Path to read the fixture from. */
  fixturePath: string;
}

export type DaytonaMockOptions = DaytonaMockRecordOptions | DaytonaMockReplayOptions;

// --- Implementation ─────────────────────────────────────────────────

const TOOLBOX_PATH_PREFIX = "/toolbox/";

interface InFlightScenario {
  name: string;
  calls: Call[];
}

interface ReplayState {
  fixture: Fixture;
  /** Index of the next call to match — advances on each successful match. */
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
  }

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
      const raw = await readFile(opts.fixturePath, "utf8");
      const fixture = FixtureSchema.parse(JSON.parse(raw));
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
        mock.#handleWs(ws, req.url ?? "/").catch((err: Error) => {
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
    const fixture: Fixture = {
      scenario: this.#scenario.name,
      recordedAt: new Date().toISOString(),
      calls: this.#scenario.calls,
    };
    const dir = dirname(this.#opts.fixturePath);
    if (!existsSync(dir)) await mkdir(dir, { recursive: true });
    await writeFile(this.#opts.fixturePath, `${JSON.stringify(fixture, null, 2)}\n`, "utf8");
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
  async #handleWs(ws: WebSocket, path: string): Promise<void> {
    if (this.#opts.mode === "record") {
      await this.#recordWs(ws, path);
    } else {
      this.#replayWs(ws, path);
    }
  }

  async #recordWs(ws: WebSocket, path: string): Promise<void> {
    if (this.#opts.mode !== "record") return;
    const upstreamUrl = this.#resolveWsUpstreamUrl(path);
    if (!upstreamUrl) {
      ws.close(1011, "no upstream for path");
      return;
    }
    const frames: WsFrame[] = [];
    const upstream = new WebSocket(upstreamUrl, {
      headers: { Authorization: `Bearer ${this.#opts.upstreamApiKey}` },
    });

    // Server→client direction. Forward + journal.
    upstream.on("message", (data: WebSocket.RawData, isBinary: boolean) => {
      const text = data.toString();
      frames.push({ direction: "down", text });
      ws.send(data, { binary: isBinary });
    });
    upstream.on("close", (code, reason) => {
      frames.push({ direction: "close", code, reason: reason.toString() });
      this.#scenario?.calls.push({ kind: "ws", path, frames });
      try {
        ws.close(code, reason);
      } catch {
        // ws may already be closed
      }
    });
    upstream.on("error", (err) => {
      log.warn({ err: err.message, upstreamUrl }, "upstream WS errored during record");
      this.#scenario?.calls.push({ kind: "ws", path, frames });
      try {
        ws.close(1011, "upstream error");
      } catch {
        // ws may already be closed
      }
    });

    // Client→server direction. Forward + journal.
    ws.on("message", (data: WebSocket.RawData, isBinary: boolean) => {
      const text = data.toString();
      frames.push({ direction: "up", text });
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
    for (let i = replay.cursor; i < replay.fixture.calls.length; i++) {
      const call = replay.fixture.calls[i];
      if (!call || call.kind !== "ws") continue;
      if (call.path === path) {
        replay.cursor = i + 1;
        this.#emitFrames(ws, call.frames);
        return;
      }
    }
    log.warn({ path, cursor: replay.cursor }, "no WS fixture match");
    ws.close(1011, "no fixture match");
  }

  /**
   * Emit recorded server→client frames in order. Schedules via
   * `queueMicrotask` so each frame surfaces as its own `message` event
   * on the client side, matching the per-chunk delivery the SDK sees
   * over a real Daytona toolbox WS. `close` frames terminate the
   * connection with the recorded code/reason.
   */
  #emitFrames(ws: WebSocket, frames: ReadonlyArray<WsFrame>): void {
    let i = 0;
    const next = (): void => {
      while (i < frames.length) {
        const frame = frames[i++];
        if (!frame) continue;
        if (frame.direction === "up") continue; // client→server frames are not replayed
        if (frame.direction === "down" && frame.text !== undefined) {
          if (ws.readyState !== WebSocket.OPEN) return;
          ws.send(frame.text);
          queueMicrotask(next);
          return;
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
    const wsBase = base.replace(/^http(s?):/, (_, s) => `ws${s}:`).replace(/\/$/, "");
    return `${wsBase}${subPath}`;
  }

  async #handleRequest(req: IncomingMessage, res: ServerResponse): Promise<void> {
    const method = req.method ?? "GET";
    const path = req.url ?? "/";
    const bodyBuf = await this.#readBody(req);

    if (this.#opts.mode === "record") {
      await this.#recordAndForward(method, path, req.headers, bodyBuf, res);
    } else {
      this.#replayMatch(method, path, bodyBuf, res);
    }
  }

  async #recordAndForward(
    method: string,
    path: string,
    headers: IncomingMessage["headers"],
    body: Buffer,
    res: ServerResponse,
  ): Promise<void> {
    const upstreamUrl = this.#resolveUpstreamUrl(path);
    if (!upstreamUrl) {
      res.statusCode = 502;
      res.end(`daytona-mock: no upstream for path ${path}`);
      return;
    }
    const upstreamHeaders = this.#prepareUpstreamHeaders(headers);
    if (this.#opts.mode === "record") {
      // Authorization is added only to the OUTBOUND request; never
      // persisted to the fixture below.
      upstreamHeaders.Authorization = `Bearer ${this.#opts.upstreamApiKey}`;
      if (this.#opts.upstreamOrganizationId) {
        upstreamHeaders["X-Daytona-Organization-ID"] = this.#opts.upstreamOrganizationId;
      }
    }

    const upstreamResp = await fetch(upstreamUrl, {
      method,
      headers: upstreamHeaders,
      ...(body.length > 0 && { body: body as unknown as BodyInit }),
    });
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
        const rewritten = this.#rewriteCreateResponse(method, path, parsed);
        respBodyJsonForFixture = rewritten;
        respBodyForClient = Buffer.from(JSON.stringify(rewritten));
        // Recompute content-length so the proxied response doesn't
        // mismatch its body bytes after rewriting.
        respHeaders["content-length"] = String(respBodyForClient.length);
      } catch {
        respBodyTextForFixture = respBodyBuf.toString("utf8");
      }
    } else if (respBodyBuf.length > 0) {
      respBodyTextForFixture = respBodyBuf.toString("utf8");
    }

    // Journal the call. Authorization header is stripped; never write
    // a real API key to disk.
    const reqHeadersForFixture: Record<string, string> = {};
    for (const [k, v] of Object.entries(headers)) {
      if (typeof v !== "string") continue;
      if (k.toLowerCase() === "authorization") continue;
      reqHeadersForFixture[k] = v;
    }
    let reqBodyJson: unknown;
    let reqBodyText: string | undefined;
    if (body.length > 0) {
      const reqContentType = headers["content-type"];
      if (typeof reqContentType === "string" && reqContentType.includes("application/json")) {
        try {
          reqBodyJson = JSON.parse(body.toString("utf8"));
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

  #replayMatch(method: string, path: string, body: Buffer, res: ServerResponse): void {
    const replay = this.#replay;
    if (!replay) {
      res.statusCode = 500;
      res.end("daytona-mock: replay state not initialized");
      return;
    }
    // Linear scan from cursor — find the next matching call by
    // (method, path). FIFO order within a bucket so multiple POST
    // /sandbox calls return different sandboxes in the order they
    // were recorded.
    for (let i = replay.cursor; i < replay.fixture.calls.length; i++) {
      const call = replay.fixture.calls[i];
      if (!call || call.kind !== "http") continue;
      if (call.method === method && call.path === path) {
        replay.cursor = i + 1;
        res.statusCode = call.response.status;
        for (const [k, v] of Object.entries(call.response.headers ?? {})) {
          res.setHeader(k, v);
        }
        if (call.response.bodyJson !== undefined) {
          res.end(JSON.stringify(call.response.bodyJson));
        } else if (call.response.bodyText !== undefined) {
          res.end(call.response.bodyText);
        } else {
          res.end();
        }
        log.debug(
          { method, path, status: call.response.status, cursor: replay.cursor },
          "replay match",
        );
        return;
      }
    }
    log.warn({ method, path, cursor: replay.cursor }, "no fixture match");
    res.statusCode = 503;
    res.setHeader("content-type", "text/plain");
    res.end(
      `daytona-mock replay: no fixture match for ${method} ${path} after cursor ${replay.cursor}. Re-record via scripts/record-daytona-fixture.ts.`,
    );
    // Note: bodyBuf currently unused for matching. Strict body
    // comparison would force re-records on every UUID; we rely on
    // method+path+FIFO ordering.
    void body;
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
      return `${base.replace(/\/$/, "")}${subPath}`;
    }
    // Main API. Strip leading '/' before joining so we don't end up
    // with a double slash that some upstreams 308 on.
    return `${this.#opts.upstreamUrl.replace(/\/$/, "")}${path}`;
  }

  #prepareUpstreamHeaders(headers: IncomingMessage["headers"]): Record<string, string> {
    const out: Record<string, string> = {};
    for (const [k, v] of Object.entries(headers)) {
      if (typeof v !== "string") continue;
      const lower = k.toLowerCase();
      // Hop-by-hop + host are connection-scoped and would confuse
      // upstream if forwarded as-is.
      if (lower === "host" || lower === "connection" || lower === "content-length") continue;
      out[k] = v;
    }
    return out;
  }

  /**
   * If this is a `POST /sandbox` response carrying `toolboxProxyUrl`,
   * remember the real URL and rewrite the response to point at our
   * mock so the SDK's subsequent toolbox calls hit us. Returns the
   * (possibly-modified) response body.
   */
  #rewriteCreateResponse(method: string, path: string, body: unknown): unknown {
    if (method !== "POST") return body;
    if (path !== "/sandbox") return body;
    if (typeof body !== "object" || body === null) return body;
    const obj = body as Record<string, unknown>;
    const id = obj.id;
    const originalToolbox = obj.toolboxProxyUrl;
    if (typeof id !== "string" || typeof originalToolbox !== "string") return body;
    this.#toolboxUpstreams.set(id, originalToolbox);
    obj.toolboxProxyUrl = `${this.url}/toolbox/${id}`;
    return obj;
  }

  async #readBody(req: IncomingMessage): Promise<Buffer> {
    const chunks: Buffer[] = [];
    for await (const chunk of req) {
      chunks.push(typeof chunk === "string" ? Buffer.from(chunk) : (chunk as Buffer));
    }
    return Buffer.concat(chunks);
  }
}
