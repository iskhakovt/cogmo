import { mkdtemp, rm } from "node:fs/promises";
import type * as http from "node:http";
import type * as net from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { mock } from "vitest-mock-extended";
import {
  type FakeDockerDaemon,
  respondJson,
  startFakeDockerDaemon,
} from "../../test/fake-docker-daemon.js";
import { forward } from "./forward.js";

const log = vi.hoisted(() => ({ debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn() }));
vi.mock("../../logger.js", () => ({ logger: { child: () => log } }));

const EXEC_ID = "e".repeat(64);

let baseDir: string;
let daemon: FakeDockerDaemon;

beforeEach(async () => {
  baseDir = await mkdtemp(join(tmpdir(), "cogmo-proxy-forward-"));
  daemon = await startFakeDockerDaemon(join(baseDir, "docker.sock"), (_req, res) =>
    respondJson(res, 201, { Id: EXEC_ID }),
  );
});

afterEach(async () => {
  await daemon.close();
  await rm(baseDir, { recursive: true, force: true });
});

describe("forward: a reply read whole", () => {
  it("logs and destroys the client response when answering throws", async () => {
    const req = mock<http.IncomingMessage>({
      method: "POST",
      url: "/containers/abc/exec",
      headers: { "content-type": "application/json" },
      socket: mock<net.Socket>({ destroyed: false }),
    });
    const res = mock<http.ServerResponse>({ destroyed: false });
    res.writeHead.mockImplementation(() => {
      throw new Error("a bug in the relay");
    });
    const record = vi.fn();

    forward(
      req,
      res,
      { socketPath: daemon.socketPath, signal: new AbortController().signal },
      {
        path: "/containers/abc/exec",
        body: { kind: "rebuilt", bytes: Buffer.from('{"Cmd":["id"]}') },
        response: { kind: "exec_created", record },
        whenClientGone: "drop",
      },
    );

    await vi.waitFor(() => expect(res.destroy).toHaveBeenCalled());
    expect(record).toHaveBeenCalledWith(EXEC_ID);
    expect(log.error).toHaveBeenCalledWith(
      expect.objectContaining({ err: expect.any(Error) }),
      "relaying a buffered daemon reply failed",
    );
  });
});
