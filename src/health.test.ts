import type { Server } from "node:http";
import type { AddressInfo } from "node:net";
import { afterEach, describe, expect, it, vi } from "vitest";
import { createHealthServer } from "./health.js";

vi.mock("./env.js", () => ({
  env: {
    VERSION: "1.2.3",
    GIT_SHA: "abc1234",
  },
}));

async function listen(server: Server): Promise<number> {
  await new Promise<void>((resolve) => server.listen(0, resolve));
  return (server.address() as AddressInfo).port;
}

describe("health server", () => {
  let server: Server;

  afterEach(() => {
    if (server) server.close();
  });

  it("serves /health with 200 + IETF health+json body", async () => {
    server = createHealthServer();
    const port = await listen(server);

    const res = await fetch(`http://127.0.0.1:${port}/health`);
    expect(res.status).toBe(200);
    expect(res.headers.get("content-type")).toBe("application/health+json");

    const body = await res.json();
    expect(body).toMatchObject({
      status: "pass",
      version: "1.2.3",
      releaseId: "abc1234",
      description: "cogmo",
    });
    expect(Array.isArray(body.notes)).toBe(true);
    expect(body.notes.some((n: string) => n.startsWith("node:"))).toBe(true);
    expect(body.notes.some((n: string) => n.startsWith("startedAt:"))).toBe(true);
  });

  it("returns 404 for unknown paths", async () => {
    server = createHealthServer();
    const port = await listen(server);

    const res = await fetch(`http://127.0.0.1:${port}/nonexistent`);
    expect(res.status).toBe(404);
    expect(await res.text()).toBe("Not Found");
  });

  it("returns 404 for non-GET methods on /health", async () => {
    server = createHealthServer();
    const port = await listen(server);

    const res = await fetch(`http://127.0.0.1:${port}/health`, { method: "POST" });
    expect(res.status).toBe(404);
  });
});
