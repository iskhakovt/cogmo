import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import type { Transport } from "@modelcontextprotocol/sdk/shared/transport.js";
import type { Transactor } from "../../db/index.js";
import type { SecretsStore } from "../../secrets/store/index.js";
import type { McpServerConfig, McpValueSource } from "../config.js";

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
      });
    case "http": {
      const headers = await resolveVarMap(config.headers, secrets, runInTx);
      // SDK 1.25 types `StreamableHTTPClientTransport.sessionId` as `string |
      // undefined`, but the `Transport` interface declares it `sessionId?:
      // string` — incompatible under `exactOptionalPropertyTypes`. Runtime
      // behaviour is identical; the cast bridges the type gap.
      return new StreamableHTTPClientTransport(new URL(config.url), {
        requestInit: { headers },
      }) as unknown as Transport;
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
