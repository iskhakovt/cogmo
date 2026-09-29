import { describe, expect, it } from "vitest";
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

describe("HostRunner.spawn", () => {
  it("abandons a connect whose server never answers once its signal aborts", async () => {
    // Answers nothing, so `initialize` would wait out the SDK's own timeout; exits once its stdin closes.
    const silent = stdioServer(process.execPath, [
      "-e",
      'process.stdin.resume(); process.stdin.on("end", () => process.exit(0));',
    ]);
    const abort = new AbortController();
    const spawning = new HostRunner().spawn(
      silent,
      mock<SecretsStore>(),
      fakeRunInTx,
      abort.signal,
    );
    setTimeout(() => abort.abort(new Error("evicted")), 200);
    await expect(spawning).rejects.toThrow(/evicted/);
  });

  it("starts nothing under a signal that has already aborted", async () => {
    const missing = stdioServer("/nonexistent/cogmo-mcp-server", []);
    const abort = new AbortController();
    abort.abort(new Error("evicted"));
    await expect(
      new HostRunner().spawn(missing, mock<SecretsStore>(), fakeRunInTx, abort.signal),
    ).rejects.toThrow("evicted");
  });
});
