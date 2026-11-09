import { err as failed, ok } from "neverthrow";
import { describe, expect, it, vi } from "vitest";
import { mock } from "vitest-mock-extended";
import type { ConnectorRow, ConnectorStore } from "../connector/store/index.js";
import { hashConnectorToken } from "../connector/token.js";
import { expectDefined } from "../test/assertions.js";
import { captureIo, fakeRunInTx } from "../test/factories.js";
import { type ConnectorCliDeps, connectorCli } from "./connector.js";
import { type CliIo, type LoadDeps, runCli } from "./run.js";

function run(argv: readonly string[], deps: ConnectorCliDeps, io: CliIo): Promise<number> {
  return runCli(
    connectorCli(io, async () => deps),
    argv,
    io,
  );
}

function deps() {
  const connectorStore = mock<ConnectorStore>();
  connectorStore.insert.mockResolvedValue(ok({ id: "c1" }));
  connectorStore.rotateToken.mockResolvedValue(ok({ id: "c1" }));
  connectorStore.revoke.mockResolvedValue(ok({ id: "c1" }));
  connectorStore.list.mockResolvedValue([]);
  return { runInTx: fakeRunInTx, connectorStore };
}

const TOKEN_LINE = /^[A-Za-z0-9_-]{43}$/;

describe("connectorCli", () => {
  it.each([
    [[]],
    [["--help"]],
    [["add", "--help"]],
    [["rotate", "--help"]],
    [["revoke", "--help"]],
    [["list", "--help"]],
  ])("prints help for %j on stdout, exits 0, and loads nothing", async (argv) => {
    const loadDeps = vi.fn<LoadDeps<ConnectorCliDeps>>(async () => deps());
    const { io, out, err } = captureIo();

    const code = await runCli(connectorCli(io, loadDeps), argv, io);

    expect(code).toBe(0);
    expect(out.join("\n")).toMatch(/^connector/);
    expect(err).toEqual([]);
    expect(loadDeps).not.toHaveBeenCalled();
  });

  it.each([["frobnicate"], ["help"]])("rejects %s as a subcommand (exit 2)", async (word) => {
    const { io, err } = captureIo();
    expect(await run([word], deps(), io)).toBe(2);
    expect(err.join("\n")).toMatch(new RegExp(`${word}\\n\\s+\\^ Not a valid subcommand name`));
  });

  describe("add", () => {
    it("prints the token on its own first line and stores its hash", async () => {
      const { io, out, err } = captureIo();
      const d = deps();

      expect(await run(["add", "laptop", "--kind", "coding"], d, io)).toBe(0);

      const [token, ...rest] = out;
      expect(token).toMatch(TOKEN_LINE);
      expect(rest.join("\n")).toContain('Added coding connector "laptop"');
      expect(rest.join("\n")).toContain("shown only once");
      expect(rest.join("\n")).toContain("connector's config");
      expect(err).toEqual([]);
      expect(d.connectorStore.insert).toHaveBeenCalledWith(expect.anything(), {
        name: "laptop",
        kind: "coding",
        tokenHash: hashConnectorToken(expectDefined(token, "token line")),
      });
    });

    it("reports a name an active connector holds (exit 1)", async () => {
      const { io, out, err } = captureIo();
      const d = deps();
      d.connectorStore.insert.mockResolvedValue(failed({ kind: "name_taken" }));

      expect(await run(["add", "laptop", "--kind", "coding"], d, io)).toBe(1);
      expect(err.join("\n")).toContain('An active connector named "laptop" already exists.');
      expect(out).toEqual([]);
    });

    it.each([
      [["Laptop", "--kind", "coding"], /Invalid connector name "Laptop": it must be lowercase/],
      [["laptop"], /No value provided for --kind/],
      [["laptop", "--kind"], /No value provided for --kind/],
      [["laptop", "--kind", "chat"], /Invalid value 'chat'/],
      [[], /No value provided for name/],
      [["laptop", "extra", "--kind", "coding"], /Unknown arguments/],
    ])("rejects add %j with exit 2 before loading anything", async (args, message) => {
      const loadDeps = vi.fn<LoadDeps<ConnectorCliDeps>>(async () => deps());
      const { io, out, err } = captureIo();

      const code = await runCli(connectorCli(io, loadDeps), ["add", ...args], io);

      expect(code).toBe(2);
      expect(err.join("\n")).toMatch(message);
      expect(out).toEqual([]);
      expect(loadDeps).not.toHaveBeenCalled();
    });
  });

  describe("rotate", () => {
    it("prints the new token on its own first line and stores its hash", async () => {
      const { io, out, err } = captureIo();
      const d = deps();

      expect(await run(["rotate", "laptop"], d, io)).toBe(0);

      const [token, ...rest] = out;
      expect(token).toMatch(TOKEN_LINE);
      const guidance = rest.join("\n");
      expect(guidance).toContain("shown only once");
      expect(guidance).toContain("The old token stops working within 30 s.");
      expect(guidance).toContain("within the lease");
      expect(err).toEqual([]);
      expect(d.connectorStore.rotateToken).toHaveBeenCalledWith(expect.anything(), {
        name: "laptop",
        tokenHash: hashConnectorToken(expectDefined(token, "token line")),
      });
    });

    it("reports a name with no active connector (exit 1)", async () => {
      const { io, out, err } = captureIo();
      const d = deps();
      d.connectorStore.rotateToken.mockResolvedValue(failed({ kind: "not_found" }));

      expect(await run(["rotate", "ghost"], d, io)).toBe(1);
      expect(err.join("\n")).toContain('No active connector named "ghost".');
      expect(out).toEqual([]);
    });
  });

  describe("revoke", () => {
    it("revokes the connector and says what it costs", async () => {
      const { io, out, err } = captureIo();
      const d = deps();

      expect(await run(["revoke", "laptop"], d, io)).toBe(0);

      const text = out.join("\n");
      expect(text).toContain('Revoked connector "laptop".');
      expect(text).toContain("stream closes within 30 s");
      expect(text).toContain("jobs in flight are lost");
      expect(err).toEqual([]);
      expect(d.connectorStore.revoke).toHaveBeenCalledWith(expect.anything(), {
        name: "laptop",
        now: expect.any(Date),
      });
    });

    it("reports a name with no active connector (exit 1)", async () => {
      const { io, out, err } = captureIo();
      const d = deps();
      d.connectorStore.revoke.mockResolvedValue(failed({ kind: "not_found" }));

      expect(await run(["revoke", "ghost"], d, io)).toBe(1);
      expect(err.join("\n")).toContain('No active connector named "ghost".');
      expect(out).toEqual([]);
    });
  });

  it.each([
    [["rotate"], /No value provided for name/],
    [["revoke"], /No value provided for name/],
    [["revoke", "--all"], /--all\n\s+\^ Unknown arguments/],
  ])("rejects %j with exit 2 before loading anything", async (argv, message) => {
    const loadDeps = vi.fn<LoadDeps<ConnectorCliDeps>>(async () => deps());
    const { io, err } = captureIo();

    expect(await runCli(connectorCli(io, loadDeps), argv, io)).toBe(2);
    expect(err.join("\n")).toMatch(message);
    expect(loadDeps).not.toHaveBeenCalled();
  });

  describe("list", () => {
    it("says so when there are none", async () => {
      const { io, out } = captureIo();
      expect(await run(["list"], deps(), io)).toBe(0);
      expect(out).toEqual(["No connectors."]);
    });

    it("prints a line per connector, revoked ones included", async () => {
      const rows: ConnectorRow[] = [
        {
          id: "c1",
          name: "laptop",
          kind: "coding",
          status: "revoked",
          createdAt: new Date("2026-11-01T10:00:00.000Z"),
          revokedAt: new Date("2026-11-02T10:00:00.000Z"),
        },
        {
          id: "c2",
          name: "laptop",
          kind: "coding",
          status: "active",
          createdAt: new Date("2026-11-03T10:00:00.000Z"),
          revokedAt: null,
        },
      ];
      const d = deps();
      d.connectorStore.list.mockResolvedValue(rows);
      const { io, out } = captureIo();

      expect(await run(["list"], d, io)).toBe(0);
      expect(out).toEqual([
        "name\tkind\tstatus\tcreated\trevoked",
        "laptop\tcoding\trevoked\t2026-11-01T10:00:00.000Z\t2026-11-02T10:00:00.000Z",
        "laptop\tcoding\tactive\t2026-11-03T10:00:00.000Z\t-",
      ]);
    });
  });
});
