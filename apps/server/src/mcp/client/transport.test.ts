import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import {
  ReadBuffer,
  STDIO_DEFAULT_MAX_BUFFER_SIZE,
} from "@modelcontextprotocol/sdk/shared/stdio.js";
import { describe, expect, it } from "vitest";
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
