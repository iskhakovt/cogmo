import { createServer } from "node:http";
import type { AddressInfo } from "node:net";
import { Writable } from "node:stream";
import { Bot, HttpError } from "grammy";
import pino from "pino";
import { beforeAll, describe, expect, it } from "vitest";
import { createLogger } from "./logger.js";

/** Shaped like a Bot API token (numeric id, colon, URL-safe base64), but not one. */
const FAKE_SECRET = "AAFake-TokenForTests_0123456789abcdef";
const FAKE_TOKEN = `123456789:${FAKE_SECRET}`;

/** A destination that keeps every line written to it. */
function capture(): { stream: Writable; lines: string[] } {
  const lines: string[] = [];
  const stream = new Writable({
    write(chunk: Buffer, _encoding, callback) {
      lines.push(chunk.toString());
      callback();
    },
  });
  return { stream, lines };
}

/**
 * The `HttpError` grammY throws when a Bot API request can't connect: its
 * message names only the method, but it keeps node-fetch's error on
 * `.error`, and that error's message names the URL — token included.
 */
let networkFailure: HttpError;

beforeAll(async () => {
  const closed = createServer();
  await new Promise<void>((resolve) => closed.listen(0, "127.0.0.1", resolve));
  const port = (closed.address() as AddressInfo).port;
  await new Promise<void>((resolve) => closed.close(() => resolve()));
  const bot = new Bot(FAKE_TOKEN, { client: { apiRoot: `http://127.0.0.1:${port}` } });
  const failure: unknown = await bot.api.getMe().catch((e: unknown) => e);
  if (!(failure instanceof HttpError)) throw new Error("expected grammY to throw an HttpError");
  networkFailure = failure;
});

describe("createLogger", () => {
  it("writes a grammY network failure without the bot token", () => {
    const { stream, lines } = capture();

    createLogger(stream).error({ err: networkFailure }, "telegram polling loop failed");

    const line = lines.join("");
    expect(line).not.toContain(FAKE_SECRET);
    // The nested node-fetch error is still there, with the token segment redacted.
    expect(line).toContain("/bot<redacted>/getMe");
    expect(line).toContain("telegram polling loop failed");
  });

  it("redacts a token wherever it appears in the record, child loggers included", () => {
    const { stream, lines } = capture();

    createLogger(stream)
      .child({ component: "telegram" })
      .warn(
        { url: `https://api.telegram.org/file/bot${FAKE_TOKEN}/photos/file_7.jpg` },
        `download from https://api.telegram.org/file/bot${FAKE_TOKEN}/photos/file_7.jpg failed`,
      );

    const line = lines.join("");
    expect(line).not.toContain(FAKE_SECRET);
    expect(line.match(/\/file\/bot<redacted>\/photos\/file_7\.jpg/g)).toHaveLength(2);
  });

  it("leaves records without a token as pino wrote them", () => {
    const { stream, lines } = capture();

    createLogger(stream).info({ url: "https://api.anthropic.com/v1/messages" }, "plain");

    const record = JSON.parse(lines.join("")) as Record<string, unknown>;
    expect(record).toMatchObject({ url: "https://api.anthropic.com/v1/messages", msg: "plain" });
  });

  it("would otherwise write the token: pino's err serializer reaches node-fetch's message", () => {
    const { stream, lines } = capture();

    pino(stream).error({ err: networkFailure }, "telegram polling loop failed");

    expect(lines.join("")).toContain(FAKE_SECRET);
  });
});
