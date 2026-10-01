/** `/mcp`: MCP server registration and tool approval. */

import { type McpServerStatus, SERVER_NAME_RE } from "../../../../mcp/config.js";
import { truncate } from "../../../../util/string.js";
import type { Transport } from "../../../transport.js";
import { errorMessage, type TelegramCommandContext } from "./reply.js";

const USAGE =
  "Usage: /mcp [list|add <name> <config-json>|remove <name>|approve <name> [<tool>]|reject <name> <tool>|pending]\n" +
  '  /mcp add github {"transport":"stdio","command":"npx","args":["-y","@modelcontextprotocol/server-github"],"env":{"GITHUB_PERSONAL_ACCESS_TOKEN":{"kind":"secret","name":"mcp:github:token"}}}\n' +
  "  /mcp approve <name>            → connect, snapshot tools (pending), mark server approved\n" +
  "  /mcp approve <name> <tool>     → flip a single tool to approved (visible to the agent)\n" +
  "  /mcp reject <name> <tool>      → mark tool rejected (hidden from the agent)";

export async function handleMcp(transport: Transport, ctx: TelegramCommandContext): Promise<void> {
  const handle = String(ctx.from.id);
  const raw = (ctx.match ?? "").trim();
  if (!raw) {
    await ctx.reply(USAGE);
    return;
  }

  // Parse the leading subcommand off; preserve the rest verbatim because
  // /mcp add carries trailing JSON which must not be re-tokenised.
  const firstSpace = raw.indexOf(" ");
  const subcommand = (firstSpace === -1 ? raw : raw.slice(0, firstSpace)).toLowerCase();
  const rest = firstSpace === -1 ? "" : raw.slice(firstSpace + 1).trim();
  const args = rest.split(/\s+/).filter(Boolean);

  switch (subcommand) {
    case "list":
      return replyList(transport, ctx, handle);
    case "pending":
      return replyPending(transport, ctx, handle);
    case "add":
      return replyAdd(transport, ctx, handle, rest);
    case "remove":
    case "rm":
      return replyRemove(transport, ctx, handle, args[0]);
    case "approve":
      return replyApprove(transport, ctx, handle, args[0], args[1]);
    case "reject":
      return replyReject(transport, ctx, handle, args[0], args[1]);
    default:
      await ctx.reply(USAGE);
  }
}

async function replyList(
  transport: Transport,
  ctx: TelegramCommandContext,
  handle: string,
): Promise<void> {
  const res = await transport.mcp.listServers(handle);
  if (res.isErr()) {
    await ctx.reply(errorMessage(res.error));
    return;
  }
  if (res.value.length === 0) {
    await ctx.reply("No MCP servers configured. Add one with `/mcp add <name> <config-json>`.");
    return;
  }
  const lines = res.value.map((s) => {
    const transportKind = s.config.transport;
    const enabledMark = s.enabled ? "" : " (disabled)";
    const counts = `${s.approvedToolCount}/${s.toolCount} tool${s.toolCount === 1 ? "" : "s"} approved`;
    const tail = s.lastError ? ` — last error: ${truncate(s.lastError, 80)}` : "";
    return `${s.name} [${transportKind}] — ${s.approvalStatus}, ${counts}${enabledMark}${tail}`;
  });
  // Budget warning: when the total approved-tool count across all enabled
  // servers exceeds the configured cap, `resolveTools` drops the tail
  // alphabetically every turn. Surface a notice on `/mcp list` so the
  // operator sees this without having to read logs.
  const approvedTotal = res.value
    .filter((s) => s.enabled && s.approvalStatus === "approved")
    .reduce((sum, s) => sum + s.approvedToolCount, 0);
  const budget = transport.mcp.toolBudget();
  const budgetNote =
    budget > 0 && approvedTotal > budget
      ? `\n\n⚠ ${approvedTotal} approved tools exceed budget ${budget} — ${approvedTotal - budget} will be dropped per turn alphabetically. Tighten profile.toolSet globs to pick which tools the agent sees.`
      : "";
  await ctx.reply(`MCP servers:\n${lines.join("\n")}${budgetNote}`);
}

async function replyPending(
  transport: Transport,
  ctx: TelegramCommandContext,
  handle: string,
): Promise<void> {
  const res = await transport.mcp.listServers(handle);
  if (res.isErr()) {
    await ctx.reply(errorMessage(res.error));
    return;
  }
  const pending = res.value.filter(
    (s) => s.approvalStatus !== "approved" || s.toolCount > s.approvedToolCount,
  );
  if (pending.length === 0) {
    await ctx.reply("Nothing pending — every server and tool is approved.");
    return;
  }
  const lines = pending.map((s) => {
    const tail =
      s.toolCount > s.approvedToolCount
        ? ` (${s.toolCount - s.approvedToolCount} tool${s.toolCount - s.approvedToolCount === 1 ? "" : "s"} pending)`
        : "";
    return `${s.name} — server status: ${s.approvalStatus}${tail}`;
  });
  await ctx.reply(`Pending approvals:\n${lines.join("\n")}`);
}

async function replyAdd(
  transport: Transport,
  ctx: TelegramCommandContext,
  handle: string,
  rest: string,
): Promise<void> {
  // Pre-check the name shape against the same regex the store enforces,
  // so a typo'd name surfaces a precise error instead of round-tripping
  // through the schema layer as a generic mcp_invalid_config.
  const nameMatch = rest.match(/^(\S+)\s+(\{.*\})$/s);
  if (!nameMatch || nameMatch[1] === undefined || nameMatch[2] === undefined) {
    await ctx.reply(USAGE);
    return;
  }
  const name = nameMatch[1];
  const json = nameMatch[2];
  if (!SERVER_NAME_RE.test(name)) {
    await ctx.reply(
      `Invalid MCP server name: ${JSON.stringify(name)} — must match ${SERVER_NAME_RE.source} (lowercase, alphanumerics, single underscores between segments).`,
    );
    return;
  }
  let config: unknown;
  try {
    config = JSON.parse(json);
  } catch (e) {
    await ctx.reply(`Invalid JSON: ${e instanceof Error ? e.message : String(e)}\n\n${USAGE}`);
    return;
  }
  const res = await transport.mcp.addServer(handle, {
    name,
    config,
    enabled: true,
  });
  if (res.isErr()) {
    await ctx.reply(errorMessage(res.error));
    return;
  }
  await ctx.reply(
    `MCP server "${res.value.name}" added (status: ${res.value.approvalStatus}).\nRun /mcp approve ${res.value.name} to connect, snapshot tools, and enable approval.`,
  );
}

/** The caller's server named `name`, or `undefined` once the reply says why there is none. */
async function findServer(
  transport: Transport,
  ctx: TelegramCommandContext,
  handle: string,
  name: string,
): Promise<McpServerStatus | undefined> {
  const lookup = await transport.mcp.listServers(handle);
  if (lookup.isErr()) {
    await ctx.reply(errorMessage(lookup.error));
    return undefined;
  }
  const server = lookup.value.find((s) => s.name === name);
  if (!server) {
    await ctx.reply(`No MCP server named "${name}".`);
    return undefined;
  }
  return server;
}

async function replyRemove(
  transport: Transport,
  ctx: TelegramCommandContext,
  handle: string,
  name: string | undefined,
): Promise<void> {
  if (!name) {
    await ctx.reply(USAGE);
    return;
  }
  const server = await findServer(transport, ctx, handle, name);
  if (!server) return;
  const res = await transport.mcp.removeServer(handle, server.id);
  if (res.isErr()) {
    await ctx.reply(errorMessage(res.error));
    return;
  }
  await ctx.reply(`MCP server "${name}" removed.`);
}

async function replyApprove(
  transport: Transport,
  ctx: TelegramCommandContext,
  handle: string,
  name: string | undefined,
  toolName: string | undefined,
): Promise<void> {
  if (!name) {
    await ctx.reply(USAGE);
    return;
  }
  const server = await findServer(transport, ctx, handle, name);
  if (!server) return;

  if (toolName) {
    const res = await transport.mcp.approveTool(handle, server.id, toolName);
    if (res.isErr()) {
      await ctx.reply(errorMessage(res.error));
      return;
    }
    await ctx.reply(`Tool "${name}.${toolName}" approved.`);
    return;
  }

  const res = await transport.mcp.approveServer(handle, server.id);
  if (res.isErr()) {
    await ctx.reply(errorMessage(res.error));
    return;
  }
  await ctx.reply(
    `MCP server "${name}" approved.\nTools snapshotted as pending — run /mcp approve ${name} <tool> per tool to surface them to the agent.`,
  );
}

async function replyReject(
  transport: Transport,
  ctx: TelegramCommandContext,
  handle: string,
  name: string | undefined,
  toolName: string | undefined,
): Promise<void> {
  if (!name || !toolName) {
    await ctx.reply(USAGE);
    return;
  }
  const server = await findServer(transport, ctx, handle, name);
  if (!server) return;
  const res = await transport.mcp.rejectTool(handle, server.id, toolName);
  if (res.isErr()) {
    await ctx.reply(errorMessage(res.error));
    return;
  }
  await ctx.reply(`Tool "${name}.${toolName}" rejected.`);
}
