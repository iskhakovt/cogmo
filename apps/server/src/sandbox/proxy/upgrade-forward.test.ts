import { mkdtemp, rm } from "node:fs/promises";
import type * as http from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Duplex, PassThrough } from "node:stream";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { mock } from "vitest-mock-extended";
import {
  type FakeDockerDaemon,
  respondJson,
  startFakeDockerDaemon,
} from "../../test/fake-docker-daemon.js";
import { forwardUpgrade } from "./upgrade-forward.js";

const log = vi.hoisted(() => ({ debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn() }));
vi.mock("../../logger.js", () => ({ logger: { child: () => log } }));

const EXEC_ID = "e".repeat(64);
const START = `/exec/${EXEC_ID}/start`;

let baseDir: string;
let daemon: FakeDockerDaemon;

beforeEach(async () => {
  baseDir = await mkdtemp(join(tmpdir(), "cogmo-proxy-upgrade-forward-"));
  daemon = await startFakeDockerDaemon(join(baseDir, "docker.sock"), (_req, res) =>
    respondJson(res, 200, {}),
  );
});

afterEach(async () => {
  await daemon.close();
  await rm(baseDir, { recursive: true, force: true });
});

/** An exec start upgrade as the HTTP server hands it over. */
function startRequest(): http.IncomingMessage {
  const req = mock<http.IncomingMessage>({ method: "POST", url: START });
  // A plain object: a mocked one answers every header with a function.
  req.headers = { host: "docker", connection: "Upgrade", upgrade: "tcp" };
  return req;
}

function upstream(): { socketPath: string; signal: AbortSignal } {
  return { socketPath: daemon.socketPath, signal: new AbortController().signal };
}

/** A client connection that sends nothing, stays open, and keeps what the proxy writes to it. */
function openClient(): { socket: Duplex; written: () => string } {
  let written = "";
  const socket = new Duplex({
    read() {},
    write(chunk: Buffer, _encoding, callback) {
      written += chunk.toString("latin1");
      callback();
    },
  });
  // As `handleUpgrade` listens on a real one.
  socket.on("error", () => {});
  return { socket, written: () => written };
}

const EMPTY = { path: START, body: Buffer.alloc(0), head: Buffer.from("held") };

describe("forwardUpgrade", () => {
  it("opens no daemon connection for a client connection already destroyed", async () => {
    const client = new PassThrough();
    client.destroy();

    forwardUpgrade(
      startRequest(),
      client,
      { path: START, body: Buffer.alloc(0), head: Buffer.alloc(0) },
      upstream(),
      vi.fn(),
    );
    await new Promise((resolve) => setTimeout(resolve, 100));

    expect(daemon.connections()).toBe(0);
  });

  it("closes the daemon connection of a client gone while the daemon holds its answer, unlogged and unanswered", async () => {
    daemon.holdUpgrades();
    const client = new PassThrough();
    const reject = vi.fn();
    forwardUpgrade(startRequest(), client, EMPTY, upstream(), reject);
    await vi.waitFor(() => expect(daemon.upgrades()).toHaveLength(1));

    client.destroy();

    await vi.waitFor(() =>
      expect(daemon.upgrades()).toMatchObject([{ answer: "held", received: "", closed: true }]),
    );
    await new Promise((resolve) => setTimeout(resolve, 100));
    expect(log.warn).not.toHaveBeenCalled();
    expect(reject).not.toHaveBeenCalled();
  });

  it("closes the daemon request when the task's signal aborts while the daemon holds its answer", async () => {
    daemon.holdUpgrades();
    const task = new AbortController();
    const client = openClient();
    forwardUpgrade(
      startRequest(),
      client.socket,
      EMPTY,
      { socketPath: daemon.socketPath, signal: task.signal },
      vi.fn(),
    );
    await vi.waitFor(() => expect(daemon.upgrades()).toHaveLength(1));

    task.abort();

    await vi.waitFor(() =>
      expect(daemon.upgrades()).toMatchObject([{ answer: "held", received: "", closed: true }]),
    );
    expect(client.socket.destroyed).toBe(false);
  });

  it("closes the daemon connection when the task's signal aborts after the switch", async () => {
    const task = new AbortController();
    const client = openClient();
    forwardUpgrade(
      startRequest(),
      client.socket,
      EMPTY,
      { socketPath: daemon.socketPath, signal: task.signal },
      vi.fn(),
    );
    await vi.waitFor(() => expect(client.written()).toMatch(/^HTTP\/1\.1 101 /));
    expect(daemon.upgrades()).toMatchObject([{ answer: "switched", closed: false }]);

    task.abort();

    await vi.waitFor(() => expect(daemon.upgrades()).toMatchObject([{ closed: true }]));
  });

  it("logs and closes both connections when relaying a refusal throws", async () => {
    const client = mock<Duplex>({ destroyed: false });
    client.end.mockImplementation(() => {
      throw new Error("a bug in the relay");
    });

    forwardUpgrade(
      startRequest(),
      client,
      { path: START, body: Buffer.from('{"Detach":true}'), head: Buffer.alloc(0) },
      upstream(),
      vi.fn(),
    );

    await vi.waitFor(() =>
      expect(log.error).toHaveBeenCalledWith(
        expect.objectContaining({ err: expect.any(Error) }),
        "relaying an upgrade's refusal failed",
      ),
    );
    expect(client.destroy).toHaveBeenCalled();
    await vi.waitFor(() => expect(daemon.upgrades()).toMatchObject([{ closed: true }]));
  });
});
