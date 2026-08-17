import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import {
  ReadBuffer,
  STDIO_DEFAULT_MAX_BUFFER_SIZE,
} from "@modelcontextprotocol/sdk/shared/stdio.js";
import { afterEach, describe, expect, it } from "vitest";
import { mock } from "vitest-mock-extended";
import type { Transaction, Transactor } from "../../db/index.js";
import type { SecretsStore } from "../../secrets/store/index.js";
import { createTransport } from "./transport.js";

/**
 * Unit tests for the transport factory. Real handshake behaviour against a
 * live MCP server is exercised by `mcp.integration.test.ts`; the cases here
 * pin the wiring we own — secret resolution into env / headers, the http /
 * sse routing, and the URL parse failure surface.
 */

const FAKE_TX = { __mockTx: true } as unknown as Transaction;
const fakeRunInTx: Transactor = (cb) => cb(FAKE_TX);

describe("createTransport", () => {
  it("builds a stdio transport with resolved env vars", async () => {
    const secrets = mock<SecretsStore>();
    secrets.getSecret.mockImplementation(async (_tx, name) =>
      name === "mcp:test:token" ? "shhh" : undefined,
    );

    const transport = await createTransport(
      {
        transport: "stdio",
        command: "node",
        args: ["-v"],
        env: {
          NODE_ENV: { kind: "literal", value: "production" },
          API_TOKEN: { kind: "secret", name: "mcp:test:token" },
        },
      },
      secrets,
      fakeRunInTx,
    );

    expect(transport).toBeInstanceOf(StdioClientTransport);
    expect(secrets.getSecret).toHaveBeenCalledWith(FAKE_TX, "mcp:test:token");
  });

  it("gives the stdio read buffer headroom beyond the SDK's default cap", async () => {
    const secrets = mock<SecretsStore>();
    const transport = await createTransport(
      { transport: "stdio", command: "node", args: ["-v"], env: {} },
      secrets,
      fakeRunInTx,
    );

    // Overflow is not a per-call failure: `ReadBuffer.append` throws, the
    // stdio transport's stdout handler catches it and closes the connection,
    // so one oversized frame takes the subprocess with it. A default-sized
    // buffer rejects this frame; ours must accept it.
    const oversizedFrame = Buffer.alloc(STDIO_DEFAULT_MAX_BUFFER_SIZE + 1);
    expect(() => new ReadBuffer().append(oversizedFrame)).toThrow(/exceeded maximum size/);

    // The buffer is a private field on the transport; reading it is the same
    // deliberate seam as `_requestInit` below, and beats spawning a
    // subprocess that emits 10 MB of stdout.
    const readBuffer = (transport as unknown as { _readBuffer: ReadBuffer })._readBuffer;
    expect(() => readBuffer.append(oversizedFrame)).not.toThrow();
  });

  it("builds a streamable-http transport and resolves header secret refs", async () => {
    const secrets = mock<SecretsStore>();
    secrets.getSecret.mockImplementation(async (_tx, name) =>
      name === "mcp:linear:bearer" ? "live-token" : undefined,
    );

    const transport = await createTransport(
      {
        transport: "http",
        url: "https://example.com/mcp",
        headers: {
          Authorization: { kind: "secret", name: "mcp:linear:bearer" },
          "X-Cogmo": { kind: "literal", value: "yes" },
        },
      },
      secrets,
      fakeRunInTx,
    );

    expect(transport).toBeInstanceOf(StreamableHTTPClientTransport);
    expect(secrets.getSecret).toHaveBeenCalledWith(FAKE_TX, "mcp:linear:bearer");

    // The constructed transport carries the resolved headers in its private
    // `_requestInit` field — same shape the SDK's internal `_commonHeaders`
    // merges with session / accept / content-type on each request. Reading
    // the private field is a deliberate test seam (vs starting the transport
    // and intercepting fetch), which would require a live HTTP server.
    const requestInit = (transport as unknown as { _requestInit?: RequestInit })._requestInit;
    expect(requestInit?.headers).toEqual({
      Authorization: "live-token",
      "X-Cogmo": "yes",
    });
  });

  it("propagates a helpful error when an http header references a missing secret", async () => {
    const secrets = mock<SecretsStore>();
    secrets.getSecret.mockResolvedValue(undefined);

    await expect(
      createTransport(
        {
          transport: "http",
          url: "https://example.com/mcp",
          headers: { Authorization: { kind: "secret", name: "mcp:missing" } },
        },
        secrets,
        fakeRunInTx,
      ),
    ).rejects.toThrow(/mcp:missing/);
  });

  it("rejects sse transport with guidance pointing at the http transport", async () => {
    const secrets = mock<SecretsStore>();
    await expect(
      createTransport(
        {
          transport: "sse",
          url: "https://example.com/sse",
          headers: {},
        },
        secrets,
        fakeRunInTx,
      ),
    ).rejects.toThrow(/sse.*not supported.*http/i);
    expect(secrets.getSecret).not.toHaveBeenCalled();
  });
});

/**
 * A local server that answers the transport's POST with a fixed
 * `Content-Type`, so the SDK's own matching decides the outcome rather than
 * a stub of it. GET is refused with 405, which is how a server without an
 * SSE stream declines the optional one the transport may open.
 */
async function serverReplyingWith(contentType: string): Promise<{ url: string; server: Server }> {
  const server = createServer((req, res) => {
    if (req.method !== "POST") {
      res.writeHead(405).end();
      return;
    }
    let body = "";
    req.on("data", (chunk: Buffer) => {
      body += chunk.toString("utf8");
    });
    req.on("end", () => {
      const id = (JSON.parse(body) as { id: number }).id;
      res.writeHead(200, { "content-type": contentType });
      res.end(JSON.stringify({ jsonrpc: "2.0", id, result: {} }));
    });
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const address = server.address();
  if (address === null || typeof address === "string") {
    throw new Error("expected a TCP address for the probe server");
  }
  const { port } = address satisfies AddressInfo;
  return { url: `http://127.0.0.1:${port}/mcp`, server };
}

/**
 * The SDK matches a response's media type exactly, so a server whose header
 * is merely json-ish now fails the call rather than being accepted by a
 * substring test. Nothing in this repo works around that — rewriting a third
 * party's header would hide a bug in their server — but nothing exercised it
 * either, so the next tightening upstream would land unobserved.
 *
 * These drive a real `StreamableHTTPClientTransport` against a loopback
 * server. The SDK's matcher is the thing under test, so the assertions are
 * on what a caller sees: the send resolves, or it throws naming the type.
 */
describe("createTransport — streamable-http response content types", () => {
  let running: Server | undefined;

  afterEach(async () => {
    const server = running;
    running = undefined;
    if (server) await new Promise<void>((resolve) => server.close(() => resolve()));
  });

  async function send(contentType: string): Promise<void> {
    const probe = await serverReplyingWith(contentType);
    running = probe.server;
    const transport = await createTransport(
      { transport: "http", url: probe.url, headers: {} },
      mock<SecretsStore>(),
      fakeRunInTx,
    );
    await transport.start();
    try {
      await transport.send({ jsonrpc: "2.0", id: 1, method: "ping" });
    } finally {
      await transport.close();
    }
  }

  it.each([
    ["the exact media type", "application/json"],
    ["parameters, which are ignored", "application/json; charset=utf-8"],
    // Accepted only because essence extraction lowercases — a substring match
    // against the literal would have rejected it.
    ["a differently-cased media type", "Application/JSON"],
  ])("accepts %s", async (_label, contentType) => {
    await expect(send(contentType)).resolves.toBeUndefined();
  });

  it.each([
    // json-ish but not json: the substring match used to let this through.
    ["a media type that merely starts with the right prefix", "application/json-rpc"],
    // A vendor suffix was rejected before this tightening too — pinned so a
    // future loosening is a deliberate choice rather than a silent one.
    ["a vendor-suffixed json type", "application/vnd.example+json"],
    // Two copies of the header joined by the HTTP stack: the comma makes the
    // essence ambiguous, so the SDK declines to guess.
    ["joined duplicate headers", "application/json, application/json"],
  ])("rejects %s", async (_label, contentType) => {
    await expect(send(contentType)).rejects.toThrow(/Unexpected content type/);
  });
});
