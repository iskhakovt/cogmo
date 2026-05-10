/**
 * Localhost HTTP server mocking the Telegram Bot API for integration tests.
 *
 * grammY's `Bot.init()` calls `getMe` on construction, `bot.start()` calls
 * `deleteWebhook` then loops on `getUpdates`, and the channel adapter calls
 * `setMyCommands` during setup. With no mock, every integration test that
 * calls `bootstrap()` with a Telegram channel row in the DB throws "Empty
 * token!" or worse, makes real network calls.
 *
 * Why an HTTP server, not a fetch interceptor: `cli.integration.test.ts`
 * spawns a fresh Node subprocess that runs `bootstrap()` independently —
 * an in-process fetch override (the pattern used by `fal-mock.ts` and
 * `openai-voice-mock.ts`) can't reach the subprocess. A localhost server
 * is reachable from any process on the host once the URL is in the DB
 * row (`channels.credentials.apiRoot`), so the same mock serves the
 * vitest worker AND every spawned subprocess.
 *
 * Behavior:
 * - `getMe` returns a canned bot identity so `bot.init()` resolves cleanly.
 * - Every other endpoint returns `{ ok: true, result: [] | true }` — enough
 *   to keep grammY's polling loop spinning without crashing. `getUpdates`
 *   in particular returns an empty array so the bot sits idle.
 * - All requests are recorded in `calls` for tests that want to assert on
 *   what the adapter sent.
 *
 * URL pattern matches grammY's `defaultBuildUrl`: `<apiRoot>/bot<token>/<method>`.
 */

import { createServer, type IncomingMessage, type Server, type ServerResponse } from "node:http";
import type { AddressInfo } from "node:net";

const TELEGRAM_PATH_RE = /^\/bot([^/]+)\/(?:test\/)?([^/?]+)/;

const BOT_INFO = {
  id: 7000000000,
  is_bot: true,
  first_name: "Cogmo Test",
  username: "cogmo_test_bot",
  can_join_groups: true,
  can_read_all_group_messages: false,
  supports_inline_queries: false,
};

export interface TelegramMockCall {
  method: string;
  token: string;
  body: unknown;
}

export interface TelegramMockServer {
  /** Base URL — assign to `channels.credentials.apiRoot`. No trailing slash. */
  url: string;
  /** Recorded calls for test assertions. */
  calls: TelegramMockCall[];
  /** Stop the server and release the port. */
  stop(): Promise<void>;
}

async function readBody(req: IncomingMessage): Promise<string> {
  const chunks: Buffer[] = [];
  for await (const chunk of req) {
    // http IncomingMessage chunks are Buffer | string; the typeof guard above
    // narrows the alternative branch to Buffer.
    chunks.push(typeof chunk === "string" ? Buffer.from(chunk) : (chunk as Buffer));
  }
  return Buffer.concat(chunks).toString("utf-8");
}

function respond(res: ServerResponse, status: number, body: unknown): void {
  res.writeHead(status, { "Content-Type": "application/json" });
  res.end(JSON.stringify(body));
}

/**
 * Cooked response for a Telegram method. `getMe` returns a bot identity;
 * everything else returns either an empty array (`getUpdates` and other
 * list-shaped results) or `true` (acknowledgement-shaped results).
 *
 * Method-specific results live alongside the catch-all so any new method
 * grammY adds gets a sensible default — the worst that happens is grammY
 * sees `result: true` where it expected `result: []`, which surfaces as a
 * test failure rather than a silent hang.
 */
function cannedResult(method: string): unknown {
  if (method === "getMe") return BOT_INFO;
  if (method === "getUpdates") return [];
  if (method === "getMyCommands") return [];
  return true;
}

async function handle(
  req: IncomingMessage,
  res: ServerResponse,
  calls: TelegramMockCall[],
): Promise<void> {
  const url = req.url ?? "";
  const match = url.match(TELEGRAM_PATH_RE);
  if (!match) {
    respond(res, 404, { ok: false, error_code: 404, description: `unknown path: ${url}` });
    return;
  }
  const [, token, method] = match;
  if (!token || !method) {
    respond(res, 404, { ok: false, error_code: 404, description: `bad path: ${url}` });
    return;
  }

  const raw = await readBody(req);
  let body: unknown = raw;
  if (raw.length > 0) {
    try {
      body = JSON.parse(raw);
    } catch {
      // Multipart / form-encoded bodies (e.g. file uploads) reach this
      // path; keep the raw string so tests can inspect if they want, and
      // proceed without choking the bot.
    }
  }
  calls.push({ method, token, body });

  // Throttle long-poll loop: grammY's `bot.start()` re-issues `getUpdates`
  // immediately after each empty response, which spins a tight CPU loop in
  // tests. Honour the `?timeout=` query param grammY sends (default 30s) but
  // cap it to 1s so teardown never blocks waiting for a real long-poll, and
  // fall back to a small constant when no timeout is provided.
  if (method === "getUpdates") {
    const u = new URL(req.url ?? "", "http://localhost");
    const requested = Number(u.searchParams.get("timeout") ?? 0);
    const seconds = Number.isFinite(requested) ? Math.min(Math.max(requested, 0), 1) : 0;
    const delayMs = seconds > 0 ? seconds * 1000 : 100;
    await new Promise((resolve) => setTimeout(resolve, delayMs));
  }

  respond(res, 200, { ok: true, result: cannedResult(method) });
}

export async function startTelegramMockServer(): Promise<TelegramMockServer> {
  const calls: TelegramMockCall[] = [];
  const server: Server = createServer((req, res) => {
    handle(req, res, calls).catch((err) => {
      respond(res, 500, {
        ok: false,
        error_code: 500,
        description: err instanceof Error ? err.message : String(err),
      });
    });
  });

  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    // Port 0 → kernel picks an unused port. Bind to 127.0.0.1 only so the
    // server is unreachable from outside the host.
    server.listen(0, "127.0.0.1", resolve);
  });
  // Post-listen, `server.address()` is `AddressInfo` — the `string | null`
  // alternatives are pre-listen / unix-socket cases that don't apply here.
  const addr = server.address() as AddressInfo;
  const url = `http://127.0.0.1:${addr.port}`;

  return {
    url,
    calls,
    async stop() {
      // grammY's `bot.start()` keeps a long-poll `getUpdates` request in
      // flight; without `closeAllConnections` (Node 18.2+) `server.close`
      // would wait for it to drain and the test process would hang at
      // teardown.
      server.closeAllConnections();
      await new Promise<void>((resolve, reject) => {
        server.close((err) => (err ? reject(err) : resolve()));
      });
    },
  };
}
