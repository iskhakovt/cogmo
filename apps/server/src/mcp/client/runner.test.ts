import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { mock } from "vitest-mock-extended";
import type { Transactor } from "../../db/index.js";
import type { SecretsStore } from "../../secrets/store/index.js";
import type { McpServer } from "../config.js";
import { HostRunner } from "./runner.js";

const fakeRunInTx: Transactor = (cb) => cb({ __mockTx: true } as never);

function stdioServer(command: string, args: string[]): McpServer {
  return {
    id: "s1",
    name: "probe",
    config: { transport: "stdio", command, args, env: {} },
    enabled: true,
    approvalStatus: "approved",
    lastConnectedAt: null,
    lastError: null,
    createdAt: new Date(),
  };
}

/**
 * A server that answers nothing: it appends every line it reads to the file
 * named by its first argument, then `exit` once its stdin closes and it exits.
 */
const SILENT_SERVER = `
const fs = require("node:fs");
const log = process.argv[1];
process.on("exit", () => fs.appendFileSync(log, "exit\\n"));
const lines = require("node:readline").createInterface({ input: process.stdin });
lines.on("line", (line) => fs.appendFileSync(log, line + "\\n"));
lines.on("close", () => process.exit(0));
`;

/** `SILENT_SERVER`, except that it answers `initialize`. */
const ANSWERING_SERVER = `${SILENT_SERVER}
lines.on("line", (line) => {
  const msg = JSON.parse(line);
  if (msg.method !== "initialize") return;
  const result = { protocolVersion: msg.params.protocolVersion, capabilities: {}, serverInfo: { name: "probe", version: "0" } };
  process.stdout.write(JSON.stringify({ jsonrpc: "2.0", id: msg.id, result }) + "\\n");
});
`;

describe("HostRunner.spawn", () => {
  const dirs: string[] = [];

  afterEach(() => {
    for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
  });

  function logFile(): { path: string; lines: () => string[] } {
    const dir = mkdtempSync(join(tmpdir(), "cogmo-mcp-runner-"));
    dirs.push(dir);
    const path = join(dir, "stdin.log");
    return {
      path,
      lines: () => {
        try {
          return readFileSync(path, "utf8").split("\n").filter(Boolean);
        } catch {
          return [];
        }
      },
    };
  }

  it("abandons initialize by closing the connection, never cancelling it, and rejects once the server exits", async () => {
    const log = logFile();
    const abort = new AbortController();
    const spawning = new HostRunner().spawn(
      stdioServer(process.execPath, ["-e", SILENT_SERVER, log.path]),
      mock<SecretsStore>(),
      fakeRunInTx,
      abort.signal,
    );
    const outcome = spawning.then(
      () => "connected",
      (e: unknown) => e,
    );
    await vi.waitFor(() => expect(log.lines().join("\n")).toContain('"method":"initialize"'), {
      timeout: 5_000,
    });

    abort.abort();

    const result = await outcome;
    const exitedBeforeRejecting = log.lines().at(-1) === "exit";
    await vi.waitFor(() => expect(log.lines()).toContain("exit"), { timeout: 5_000 });
    // The MCP spec forbids cancelling `initialize`.
    expect(log.lines().filter((line) => line.includes("notifications/cancelled"))).toEqual([]);
    expect(exitedBeforeRejecting).toBe(true);
    expect(result).toMatchObject({ name: "AbortError" });
  });

  it("ignores the signal once the spawn has resolved", async () => {
    const log = logFile();
    const abort = new AbortController();
    const connection = await new HostRunner().spawn(
      stdioServer(process.execPath, ["-e", ANSWERING_SERVER, log.path]),
      mock<SecretsStore>(),
      fakeRunInTx,
      abort.signal,
    );
    const closed = vi.fn();
    connection.onClose(closed);

    abort.abort();
    await new Promise((resolve) => setTimeout(resolve, 100));
    expect(closed).not.toHaveBeenCalled();
    expect(log.lines()).not.toContain("exit");

    await connection.close();
    expect(closed).toHaveBeenCalledOnce();
    expect(log.lines().at(-1)).toBe("exit");
  });

  it("starts nothing under a signal that has already aborted", async () => {
    const missing = stdioServer("/nonexistent/cogmo-mcp-server", []);
    const abort = new AbortController();
    abort.abort();
    await expect(
      new HostRunner().spawn(missing, mock<SecretsStore>(), fakeRunInTx, abort.signal),
    ).rejects.toMatchObject({ name: "AbortError" });
  });
});
