import * as http from "node:http";
import * as net from "node:net";
import { afterEach, describe, expect, it, vi } from "vitest";
import { mock } from "vitest-mock-extended";
import { forwardCreate } from "./create-forward.js";
import type { CreateAdmission } from "./in-flight-creates.js";

afterEach(() => {
  vi.useRealTimers();
});

describe("forwardCreate", () => {
  it("arms no deadline timer for a daemon request that throws as it is built", () => {
    vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
    const req = new http.IncomingMessage(new net.Socket());
    req.method = "POST";
    req.url = "/containers/create";
    req.headers = { host: "docker" };
    const res = mock<http.ServerResponse>();
    const plan = {
      // Node refuses a path with a space before any connection is made.
      path: "/containers/create bad",
      body: Buffer.from("{}"),
      record: vi.fn(),
      admission: mock<CreateAdmission>(),
    };

    expect(() =>
      forwardCreate(
        req,
        res,
        { socketPath: "/nonexistent.sock", signal: new AbortController().signal },
        plan,
      ),
    ).toThrow(/unescaped characters/i);
    expect(vi.getTimerCount()).toBe(0);
  });
});
