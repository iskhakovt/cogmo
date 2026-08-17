import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import type { Transport } from "@modelcontextprotocol/sdk/shared/transport.js";
import type { Transactor } from "../../db/index.js";
import type { SecretsStore } from "../../secrets/store/index.js";
import type { McpServerConfig, McpValueSource } from "../config.js";

/**
 * Ceiling on the stdio read buffer, in bytes — the largest single JSON-RPC
 * frame we accept from an MCP server subprocess.
 *
 * The SDK applies its own default when the option is omitted, and an overflow
 * is not a per-call failure: `ReadBuffer.append` throws, the stdio transport's
 * stdout handler catches it and closes the whole connection, so one oversized
 * response takes the subprocess down and the pool has to respawn it. That
 * makes the bound a behavioural decision worth owning explicitly rather than
 * inheriting, so it is pinned here and moves only when we choose to move it.
 *
 * 32 MiB is generous relative to any response an agent can actually consume —
 * a tool result an order of magnitude smaller already overruns a model's
 * context window — while still capping how much a misbehaving server can
 * accumulate in memory before we cut it off.
 */
const STDIO_MAX_BUFFER_BYTES = 32 * 1024 * 1024;

/**
 * Construct an SDK `Transport` from a server config + the secrets store
 * (resolves `SecretRef` env / header values to plaintext at construction).
 *
 * stdio and streamable-http are supported. `sse` (the deprecated split
 * GET/POST transport) stays deferred — modern remote servers ship the
 * streamable variant. The thrown message is what surfaces to the operator
 * via `/mcp add` when somebody configures `transport: "sse"`.
 */
export async function createTransport(
  config: McpServerConfig,
  secrets: SecretsStore,
  runInTx: Transactor,
): Promise<Transport> {
  switch (config.transport) {
    case "stdio":
      return new StdioClientTransport({
        command: config.command,
        args: config.args,
        env: await resolveVarMap(config.env, secrets, runInTx),
        // Pipe stderr so we can forward it to the structured log instead of
        // letting MCP server diagnostics leak into the parent process's stderr.
        stderr: "pipe",
        maxBufferSize: STDIO_MAX_BUFFER_BYTES,
      });
    case "http": {
      const headers = await resolveVarMap(config.headers, secrets, runInTx);
      // The endpoint must answer a POST carrying requests with a `Content-Type`
      // whose media type is exactly `application/json` or `text/event-stream`
      // (parameters such as `charset=utf-8` are fine, the comparison ignores
      // them). Anything else — `application/json-rpc`, a vendor `+json`
      // suffix, duplicate headers the fetch layer joins with a comma — makes
      // the SDK reject the response with "Unexpected content type" and fail
      // that tool call. This is the Streamable HTTP spec's requirement, not a
      // client-side preference, so a non-conforming server is a server bug to
      // report upstream; `SdkMcpConnection` routes the reason to the
      // structured log so the operator gets the media type it saw.
      //
      // SDK declares `sessionId: string | undefined`; `Transport` declares
      // `sessionId?: string` — incompatible under `exactOptionalPropertyTypes`.
      return new StreamableHTTPClientTransport(new URL(config.url), {
        requestInit: { headers },
      }) as Transport;
    }
    case "sse":
      throw new Error(
        `MCP sse transport is not supported; use transport: "http" for remote servers (Streamable HTTP)`,
      );
  }
}

async function resolveVarMap(
  vars: Record<string, McpValueSource>,
  secrets: SecretsStore,
  runInTx: Transactor,
): Promise<Record<string, string>> {
  const out: Record<string, string> = {};
  for (const [key, source] of Object.entries(vars)) {
    out[key] = await resolveValue(key, source, secrets, runInTx);
  }
  return out;
}

async function resolveValue(
  key: string,
  source: McpValueSource,
  secrets: SecretsStore,
  runInTx: Transactor,
): Promise<string> {
  if (source.kind === "literal") return source.value;
  const secret = await runInTx((tx) => secrets.getSecret(tx, source.name));
  if (secret === undefined) {
    throw new Error(
      `MCP secret reference for env/header ${JSON.stringify(key)} not found in secrets store: ${JSON.stringify(source.name)}`,
    );
  }
  return secret;
}
