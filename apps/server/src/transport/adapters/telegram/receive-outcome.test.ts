import { createServer } from "node:http";
import { type ApiClientOptions, Bot, GrammyError, HttpError } from "grammy";
import type { UserFromGetMe } from "grammy/types";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import {
  channelError,
  failureOutcome,
  type ReceiveOutcome,
  replyOutcome,
} from "./receive-outcome.js";
import { TokenRedactor } from "./token-redaction.js";

/** Shaped like a Bot API token (numeric id, colon, URL-safe base64), but not one. */
const TOKEN = "123456:AAsecret-tok_en";
const ENCODED = encodeURIComponent(TOKEN);
const redact = new TokenRedactor(TOKEN);

const BOT_INFO: UserFromGetMe = {
  id: 1,
  is_bot: true,
  first_name: "cogmo",
  username: "cogmo_bot",
  can_join_groups: false,
  can_read_all_group_messages: false,
  supports_inline_queries: false,
  can_connect_to_business: false,
  has_main_web_app: false,
  has_topics_enabled: false,
  allows_users_to_create_topics: false,
  can_manage_bots: false,
  supports_join_request_queries: false,
};

/** A normalized code: digits, a system code, a node-fetch type. */
const NORMALIZED_CODE = /^(\d+|[A-Z][A-Z0-9_]*|[a-z][a-z-]*)$/;

/** The long poll a `/hold/` bot has open, once it arrives. */
let longPollOpen = Promise.withResolvers<void>();

/**
 * A Bot API: under `/drop/` it drops every connection, under `/hold/` it
 * answers every call but a long poll, which it holds open, and elsewhere it
 * answers with a 502 page.
 */
const botApi = createServer((req, res) => {
  if (req.url?.startsWith("/drop/")) {
    req.socket.destroy();
    return;
  }
  if (req.url?.startsWith("/hold/")) {
    let body = "";
    req.on("data", (chunk: Buffer) => {
      body += chunk.toString();
    });
    req.on("end", () => {
      if (req.url?.endsWith("/getUpdates") && /"timeout":[1-9]/.test(body)) {
        longPollOpen.resolve();
        return;
      }
      res.writeHead(200, { "content-type": "application/json" });
      res.end(JSON.stringify({ ok: true, result: req.url?.endsWith("/getUpdates") ? [] : true }));
    });
    return;
  }
  res.writeHead(502, { "content-type": "text/html" });
  res.end("<html>Bad Gateway</html>");
});
let root: string;

beforeAll(async () => {
  await new Promise<void>((resolve) => botApi.listen(0, "127.0.0.1", resolve));
  const address = botApi.address();
  if (address === null || typeof address === "string") throw new Error("expected a TCP address");
  root = `http://127.0.0.1:${address.port}`;
});

afterAll(async () => {
  botApi.closeAllConnections();
  await new Promise<void>((resolve) => botApi.close(() => resolve()));
});

/** What grammY's own client rejects a `getUpdates` with. */
async function thrownBy(client: ApiClientOptions): Promise<unknown> {
  const bot = new Bot(TOKEN, { client });
  return bot.api.getUpdates({ timeout: 0 }).then(
    () => {
      throw new Error("expected getUpdates to fail");
    },
    (err: unknown) => err,
  );
}

const retrying = (
  cause: Extract<ReceiveOutcome, { kind: "retrying" }>["cause"],
  code: string,
  detail: string | null,
): ReceiveOutcome => ({ kind: "retrying", cause, error: { code, detail } });

describe("replyOutcome", () => {
  it.each<[string, unknown]>([
    ["a batch", { ok: true, result: [{ update_id: 7 }, { update_id: 8, message: {} }] }],
    ["an empty batch, a long-poll timeout", { ok: true, result: [] }],
  ])("reads %s as progress", (_, reply) => {
    expect(replyOutcome(reply, redact)).toEqual({ kind: "batch" });
  });

  it.each([401, 409])("leaves a %i to the supervisor", (code) => {
    expect(replyOutcome({ ok: false, error_code: code, description: "x" }, redact)).toEqual({
      kind: "supervised",
    });
  });

  it.each<[number, string]>([
    [429, "rate_limited"],
    [500, "server_error"],
    [502, "server_error"],
    [599, "server_error"],
    [400, "client_error"],
    [404, "client_error"],
  ])("reads a %i as a retry (%s), coded by error_code", (code, cause) => {
    expect(
      replyOutcome({ ok: false, error_code: code, description: "Telegram says" }, redact),
    ).toEqual({
      kind: "retrying",
      cause,
      error: { code: String(code), detail: "Telegram says" },
    });
  });

  it.each<[string, unknown, string | null]>([
    ["ok: true with no result", { ok: true }, null],
    ["a non-array result", { ok: true, result: 5 }, null],
    ["an object result", { ok: true, result: {} }, null],
    ["an update with no update_id", { ok: true, result: [{}] }, null],
    ["a string update_id", { ok: true, result: [{ update_id: "7" }] }, null],
    ["one malformed update in a batch", { ok: true, result: [{ update_id: 7 }, {}] }, null],
    ["no ok", { result: [] }, null],
    ["a string ok", { ok: "true", result: [] }, null],
    ["an error_code 302", { ok: false, error_code: 302, description: "Found" }, "Found"],
    ["an error_code past 599", { ok: false, error_code: 600 }, null],
    ["a fractional error_code", { ok: false, error_code: 450.5 }, null],
    ["a string error_code", { ok: false, error_code: "500" }, null],
    ["ok: false alone", { ok: false }, null],
    ["null", null, null],
    ["a string", "<html>", null],
  ])("reads %s as a bad reply, without progress", (_, reply, detail) => {
    expect(replyOutcome(reply, redact)).toEqual(retrying("bad_reply", "unexpected-reply", detail));
  });

  it("masks the token, raw and percent-encoded, in the description", () => {
    const outcome = replyOutcome(
      { ok: false, error_code: 502, description: `Bad Gateway for ${TOKEN} (${ENCODED})` },
      redact,
    );

    expect(outcome).toEqual(
      retrying("server_error", "502", "Bad Gateway for <redacted> (<redacted>)"),
    );
  });
});

describe("failureOutcome", () => {
  it("reads a dropped connection by its system code", async () => {
    const failure = await thrownBy({ apiRoot: `${root}/drop` });

    expect(failure).toBeInstanceOf(HttpError);
    expect(failureOutcome(failure)).toEqual(retrying("network", "ECONNRESET", null));
  });

  it("reads a reply that isn't JSON as a bad reply", async () => {
    const failure = await thrownBy({ apiRoot: `${root}/html` });

    expect(failure).toBeInstanceOf(HttpError);
    expect(failureOutcome(failure)).toEqual(retrying("bad_reply", "invalid-json", null));
  });

  it("reads grammY's client timeout", async () => {
    const unanswered: typeof globalThis.fetch = (_input, init) =>
      new Promise((_resolve, reject) => {
        init?.signal?.addEventListener("abort", () => reject(new Error("aborted")));
      });

    const failure = await thrownBy({ timeoutSeconds: 0.01, fetch: unanswered });

    expect(failure).toBeInstanceOf(HttpError);
    expect(failureOutcome(failure)).toEqual(retrying("network", "timeout", null));
  });

  it("reads the long poll bot.stop() aborts by node-fetch's type", async () => {
    longPollOpen = Promise.withResolvers<void>();
    const bot = new Bot(TOKEN, {
      botInfo: BOT_INFO,
      client: { apiRoot: `${root}/hold` },
    });
    const failures: unknown[] = [];
    bot.api.config.use((prev, method, payload, signal) =>
      prev(method, payload, signal).catch((err: unknown) => {
        failures.push(err);
        throw err;
      }),
    );
    const polling = bot.start();
    await longPollOpen.promise;

    await bot.stop();
    await polling;

    expect(failures).toHaveLength(1);
    expect(failures[0]).toBeInstanceOf(HttpError);
    expect(failureOutcome(failures[0])).toEqual(retrying("network", "aborted", null));
  });

  it("reads a throw while building the request, which grammY doesn't wrap, as unknown", async () => {
    const failure = await thrownBy({
      buildUrl: () => {
        throw new Error(`no URL for ${root}/bot${TOKEN}`);
      },
    });

    expect(failure).not.toBeInstanceOf(HttpError);
    expect(failureOutcome(failure)).toEqual(retrying("unknown", "unknown", null));
  });

  it("reads an HttpError wrapping anything but node-fetch's errors as unknown", async () => {
    const failure = await thrownBy({
      fetch: () => Promise.reject(new TypeError(`fetch ${root}/bot${TOKEN} failed`)),
    });

    expect(failure).toBeInstanceOf(HttpError);
    expect(failureOutcome(failure)).toEqual(retrying("unknown", "unknown", null));
  });

  /** A node-fetch error as node-fetch builds one: `name` on the prototype, the rest own. */
  function fetchError(fields: { type: string; code?: string }): Error {
    class FetchError extends Error {}
    Object.defineProperty(FetchError.prototype, "name", { value: "FetchError" });
    return Object.assign(
      new FetchError(`request to ${root}/bot${TOKEN}/getUpdates failed`),
      fields,
    );
  }

  it.each<[string, { type: string; code?: string }, string]>([
    ["a code that isn't a system code", { type: "system", code: `${root}/bot${TOKEN}` }, "system"],
    ["a type that isn't node-fetch's", { type: `${root}/bot${TOKEN}` }, "unknown"],
  ])("never takes a code from %s", (_, fields, code) => {
    const failure = new HttpError("Network request for 'getUpdates' failed!", fetchError(fields));

    expect(failureOutcome(failure)).toEqual(retrying("network", code, null));
  });

  it("reads any other throw as unknown", () => {
    expect(failureOutcome(new Error(`${root}/bot${TOKEN}`))).toEqual(
      retrying("unknown", "unknown", null),
    );
    expect(failureOutcome("a string")).toEqual(retrying("unknown", "unknown", null));
  });

  it("keeps the URL and the token out of every code", async () => {
    const failures = await Promise.all([
      thrownBy({ apiRoot: `${root}/drop` }),
      thrownBy({ apiRoot: `${root}/html` }),
      thrownBy({ fetch: () => Promise.reject(new TypeError(`fetch ${root}/bot${TOKEN} failed`)) }),
    ]);

    for (const failure of failures) {
      const { error } = failureOutcome(failure);
      expect(error.code).toMatch(NORMALIZED_CODE);
      expect(error.code).not.toContain("127.0.0.1");
      expect(error.code).not.toContain(TOKEN);
      expect(error.detail).toBeNull();
    }
  });
});

describe("channelError", () => {
  it("codes a Bot API refusal by its error_code, with its description masked", () => {
    const refusal = new GrammyError(
      "Call to 'deleteWebhook' failed!",
      { ok: false, error_code: 404, description: `Not Found: ${TOKEN}` },
      "deleteWebhook",
      {},
    );

    expect(channelError(refusal, redact)).toEqual({ code: "404", detail: "Not Found: <redacted>" });
  });

  it("codes a refusal whose error_code isn't a number as unknown, with no description", async () => {
    const refusal = await thrownBy({
      fetch: async () => Response.json({ ok: false, error_code: `${root}/bot${TOKEN}` }),
    });

    expect(refusal).toBeInstanceOf(GrammyError);
    expect(channelError(refusal, redact)).toEqual({ code: "unknown", detail: null });
  });

  it("codes a failed request as getUpdates reads it", async () => {
    const failure = await thrownBy({ apiRoot: `${root}/drop` });

    expect(channelError(failure, redact)).toEqual({ code: "ECONNRESET", detail: null });
  });

  it("codes anything else as unknown", () => {
    expect(channelError(new Error(`onStart threw at ${root}/bot${TOKEN}`), redact)).toEqual({
      code: "unknown",
      detail: null,
    });
  });
});
