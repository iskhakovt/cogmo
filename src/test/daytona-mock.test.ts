/**
 * Unit tests for the Daytona record/replay mock. Covers the HTTP
 * surface in isolation: a hand-crafted fixture exercises the matching
 * algorithm, and a record-mode round-trip against a local "upstream"
 * stub proves the proxy + fixture-writing path.
 */

import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { createServer, type Server } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import WebSocket from "ws";
import { DaytonaMock } from "./daytona-mock.js";

let fixtureDir: string;

beforeAll(() => {
  fixtureDir = mkdtempSync(join(tmpdir(), "daytona-mock-test-"));
});

afterAll(() => {
  rmSync(fixtureDir, { recursive: true, force: true });
});

/** Boot a throwaway HTTP server that stands in for upstream Daytona. */
async function startStubUpstream(
  handler: (
    path: string,
    method: string,
    body: string,
  ) => {
    status: number;
    bodyJson: unknown;
  },
): Promise<{ url: string; stop: () => Promise<void> }> {
  const server: Server = createServer(async (req, res) => {
    const chunks: Buffer[] = [];
    for await (const chunk of req) chunks.push(chunk as Buffer);
    const body = Buffer.concat(chunks).toString("utf8");
    const result = handler(req.url ?? "/", req.method ?? "GET", body);
    res.statusCode = result.status;
    res.setHeader("content-type", "application/json");
    res.end(JSON.stringify(result.bodyJson));
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", () => resolve()));
  const address = server.address();
  if (!address || typeof address === "string") throw new Error("upstream stub address invalid");
  return {
    url: `http://127.0.0.1:${address.port}`,
    stop: () =>
      new Promise<void>((resolve, reject) => {
        server.close((err) => (err ? reject(err) : resolve()));
      }),
  };
}

describe("DaytonaMock", () => {
  describe("replay mode", () => {
    it("returns the recorded response for a matching (method, path)", async () => {
      const fixturePath = join(fixtureDir, "single-call.json");
      const fixture = {
        scenario: "single-call",
        recordedAt: "2026-05-11T00:00:00.000Z",
        calls: [
          {
            kind: "http",
            method: "GET",
            path: "/sandbox/abc-123",
            request: {},
            response: {
              status: 200,
              headers: { "content-type": "application/json" },
              bodyJson: { id: "abc-123", state: "started" },
            },
          },
        ],
      };
      await writeFixture(fixturePath, fixture);

      const mock = await DaytonaMock.create({ mode: "replay", fixturePath });
      try {
        const resp = await fetch(`${mock.url}/sandbox/abc-123`);
        expect(resp.status).toBe(200);
        const body = (await resp.json()) as { id: string; state: string };
        expect(body).toEqual({ id: "abc-123", state: "started" });
      } finally {
        await mock.stop();
      }
    });

    it("matches multiple calls to the same (method, path) in FIFO order", async () => {
      const fixturePath = join(fixtureDir, "fifo.json");
      const fixture = {
        scenario: "fifo",
        recordedAt: "2026-05-11T00:00:00.000Z",
        calls: [
          {
            kind: "http",
            method: "POST",
            path: "/sandbox",
            request: {},
            response: { status: 200, bodyJson: { id: "first" } },
          },
          {
            kind: "http",
            method: "POST",
            path: "/sandbox",
            request: {},
            response: { status: 200, bodyJson: { id: "second" } },
          },
        ],
      };
      await writeFixture(fixturePath, fixture);

      const mock = await DaytonaMock.create({ mode: "replay", fixturePath });
      try {
        const a = await (await fetch(`${mock.url}/sandbox`, { method: "POST" })).json();
        const b = await (await fetch(`${mock.url}/sandbox`, { method: "POST" })).json();
        expect(a).toEqual({ id: "first" });
        expect(b).toEqual({ id: "second" });
      } finally {
        await mock.stop();
      }
    });

    it("returns 503 when no fixture matches", async () => {
      const fixturePath = join(fixtureDir, "empty.json");
      await writeFixture(fixturePath, {
        scenario: "empty",
        recordedAt: "2026-05-11T00:00:00.000Z",
        calls: [],
      });
      const mock = await DaytonaMock.create({ mode: "replay", fixturePath });
      try {
        const resp = await fetch(`${mock.url}/sandbox`);
        expect(resp.status).toBe(503);
        const text = await resp.text();
        expect(text).toMatch(/no fixture match/);
      } finally {
        await mock.stop();
      }
    });
  });

  describe("replay mode — WS", () => {
    it("emits recorded server→client frames in order, then closes", async () => {
      const fixturePath = join(fixtureDir, "ws-stream.json");
      await writeFixture(fixturePath, {
        scenario: "ws-stream",
        recordedAt: "2026-05-11T00:00:00.000Z",
        calls: [
          {
            kind: "ws",
            path: "/toolbox/sb-1/process/session/s/commands/c/logs",
            frames: [
              { direction: "down", text: "hello\n" },
              { direction: "down", text: "world\n" },
              { direction: "close", code: 1000, reason: "" },
            ],
          },
        ],
      });

      const mock = await DaytonaMock.create({ mode: "replay", fixturePath });
      try {
        const ws = new WebSocket(
          `${mock.url.replace(/^http/, "ws")}/toolbox/sb-1/process/session/s/commands/c/logs`,
        );
        const messages: string[] = [];
        const closed = new Promise<{ code: number; reason: string }>((resolve, reject) => {
          ws.on("message", (data) => {
            messages.push(data.toString());
          });
          ws.on("close", (code, reason) => resolve({ code, reason: reason.toString() }));
          ws.on("error", reject);
        });
        const closeEvent = await closed;
        expect(messages).toEqual(["hello\n", "world\n"]);
        expect(closeEvent.code).toBe(1000);
      } finally {
        await mock.stop();
      }
    });

    it("returns 1011 when no WS fixture matches", async () => {
      const fixturePath = join(fixtureDir, "ws-empty.json");
      await writeFixture(fixturePath, {
        scenario: "ws-empty",
        recordedAt: "2026-05-11T00:00:00.000Z",
        calls: [],
      });
      const mock = await DaytonaMock.create({ mode: "replay", fixturePath });
      try {
        const ws = new WebSocket(`${mock.url.replace(/^http/, "ws")}/toolbox/x/nope`);
        const closeCode = await new Promise<number>((resolve) => {
          ws.on("close", (code) => resolve(code));
          ws.on("error", () => undefined);
        });
        expect(closeCode).toBe(1011);
      } finally {
        await mock.stop();
      }
    });
  });

  describe("record mode", () => {
    it("forwards to upstream, rewrites toolboxProxyUrl, persists scenario", async () => {
      const upstream = await startStubUpstream((path, method) => {
        if (method === "POST" && path === "/sandbox") {
          return {
            status: 200,
            bodyJson: {
              id: "sb-fake-1",
              state: "started",
              toolboxProxyUrl: "https://upstream.daytona.app/proxy",
            },
          };
        }
        return { status: 404, bodyJson: { error: "not_found" } };
      });
      const fixturePath = join(fixtureDir, "record-create.json");
      const mock = await DaytonaMock.create({
        mode: "record",
        fixturePath,
        upstreamUrl: upstream.url,
        upstreamApiKey: "real-key-redacted",
      });
      try {
        mock.beginScenario("create-rewrites-toolbox");
        const resp = await fetch(`${mock.url}/sandbox`, {
          method: "POST",
          headers: { "content-type": "application/json", authorization: "Bearer fake-pre" },
          body: JSON.stringify({ image: "python:3.14" }),
        });
        const body = (await resp.json()) as { id: string; toolboxProxyUrl: string };
        // The SDK saw the rewritten URL pointing at the mock — toolbox
        // calls will land here too.
        expect(body.id).toBe("sb-fake-1");
        expect(body.toolboxProxyUrl).toBe(`${mock.url}/toolbox/sb-fake-1`);
        await mock.endScenario();
      } finally {
        await mock.stop();
        await upstream.stop();
      }

      // Fixture contents: original toolboxProxyUrl was rewritten in
      // the recorded response, so replay sees the same rewritten URL
      // — no re-rewrite needed at replay time.
      const persisted = JSON.parse(readFileSync(fixturePath, "utf8")) as {
        scenario: string;
        calls: Array<{
          method: string;
          path: string;
          response: { bodyJson?: { toolboxProxyUrl?: string } };
        }>;
      };
      expect(persisted.scenario).toBe("create-rewrites-toolbox");
      expect(persisted.calls).toHaveLength(1);
      const recorded = persisted.calls[0];
      expect(recorded?.method).toBe("POST");
      expect(recorded?.path).toBe("/sandbox");
      expect(recorded?.response.bodyJson?.toolboxProxyUrl).toMatch(/\/toolbox\/sb-fake-1$/);
    });

    it("strips Authorization header from recorded request — no real keys on disk", async () => {
      const upstream = await startStubUpstream(() => ({
        status: 200,
        bodyJson: { ok: true },
      }));
      const fixturePath = join(fixtureDir, "record-no-auth-leak.json");
      const mock = await DaytonaMock.create({
        mode: "record",
        fixturePath,
        upstreamUrl: upstream.url,
        upstreamApiKey: "sk-real-secret",
      });
      try {
        mock.beginScenario("redacts-auth");
        await fetch(`${mock.url}/sandbox/x`, {
          headers: { authorization: "Bearer client-token", "x-trace-id": "abc" },
        });
        await mock.endScenario();
      } finally {
        await mock.stop();
        await upstream.stop();
      }

      const text = readFileSync(fixturePath, "utf8");
      expect(text).not.toContain("sk-real-secret");
      expect(text).not.toContain("client-token");
      expect(text).toContain("x-trace-id");
    });
  });
});

async function writeFixture(path: string, content: unknown): Promise<void> {
  const { writeFile, mkdir } = await import("node:fs/promises");
  const { dirname } = await import("node:path");
  await mkdir(dirname(path), { recursive: true });
  await writeFile(path, JSON.stringify(content));
}
