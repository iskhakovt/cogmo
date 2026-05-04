import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import type { Transport } from "@modelcontextprotocol/sdk/shared/transport.js";
import type { SecretsStore } from "../../secrets/store/index.js";
import type { McpServerConfig, McpValueSource } from "../config.js";

/**
 * Construct an SDK `Transport` from a server config + the secrets store
 * (resolves `SecretRef` env / header values to plaintext at construction).
 *
 * Phase A supports stdio only; http/sse throw with a deferred-to-Phase-C
 * message rather than silently misbehaving. The thrown message is what
 * surfaces to the operator via `/mcp add`.
 */
export async function createTransport(
  config: McpServerConfig,
  secrets: SecretsStore,
): Promise<Transport> {
  switch (config.transport) {
    case "stdio":
      return new StdioClientTransport({
        command: config.command,
        args: config.args,
        env: await resolveVarMap(config.env, secrets),
        // Pipe stderr so we can forward it to the structured log instead of
        // letting MCP server diagnostics leak into the parent process's stderr.
        stderr: "pipe",
      });
    case "http":
    case "sse":
      throw new Error(
        `MCP ${config.transport} transport is deferred to Phase C; only stdio is supported in Phase A`,
      );
  }
}

async function resolveVarMap(
  vars: Record<string, McpValueSource>,
  secrets: SecretsStore,
): Promise<Record<string, string>> {
  const out: Record<string, string> = {};
  for (const [key, source] of Object.entries(vars)) {
    out[key] = await resolveValue(key, source, secrets);
  }
  return out;
}

async function resolveValue(
  key: string,
  source: McpValueSource,
  secrets: SecretsStore,
): Promise<string> {
  if (source.kind === "literal") return source.value;
  const secret = await secrets.getSecret(source.name);
  if (secret === undefined) {
    throw new Error(
      `MCP secret reference for env/header ${JSON.stringify(key)} not found in secrets store: ${JSON.stringify(source.name)}`,
    );
  }
  return secret;
}
