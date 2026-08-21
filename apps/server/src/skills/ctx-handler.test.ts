import { describe, expect, it, vi } from "vitest";
import { type MockProxy, mock } from "vitest-mock-extended";
import type { Service } from "../agent/service.js";
import type { Transactor } from "../db/index.js";
import type { MemoryProvider } from "../memory/provider.js";
import type { SecretsStore } from "../secrets/store/index.js";
import { mockFilesService } from "../test/factories.js";
import type { DefaultCtxHandlerOptions } from "./ctx-handler.js";
import { DefaultCtxHandler } from "./ctx-handler.js";
import { CtxError } from "./dispatcher.js";
import { parseManifest } from "./manifest.js";
import type { SkillManifest } from "./types.js";

const FAKE_TX = { __mockTx: true } as never;
const fakeRunInTx: Transactor = (cb) => cb(FAKE_TX);

function manifest(overrides: string = ""): SkillManifest {
  const source = `---
name: test-skill
description: a test skill for the ctx handler
tier: wasm
inputs:
  type: object
  properties: {}
${overrides}
---
`;
  const r = parseManifest(source);
  if (!r.isOk()) throw new Error("test fixture failed to parse");
  return r.value.manifest;
}

/**
 * Allowlist covering every destination the `http.request` tests reach. A skill
 * with no `network:` block has no network at all, which the default-deny cases
 * below assert directly rather than inheriting from this fixture.
 */
const HTTP_ALLOW = `network:
  allow:
    - api.example.com
    - example.com
    - x.com
    - slow-dns.example
    - internal.example
    - weird.example
    - hindsight.internal
    - 127.0.0.1
`;

function httpManifest(overrides: string = ""): SkillManifest {
  return manifest(`${HTTP_ALLOW}${overrides}`);
}

interface Deps {
  secretsStore: MockProxy<SecretsStore>;
  memory: MockProxy<MemoryProvider>;
  files: Service["files"];
  recordContextCall: DefaultCtxHandlerOptions["recordContextCall"];
}

function deps(overrides?: Partial<Deps>): Deps {
  const memory = mock<MemoryProvider>();
  memory.recall.mockResolvedValue({ memories: [] });
  return {
    secretsStore: mock<SecretsStore>(),
    memory,
    files: mockFilesService(),
    recordContextCall: vi.fn().mockResolvedValue(undefined),
    ...overrides,
  };
}

const PUBLIC_ADDRESS = [{ address: "104.18.32.7", family: 4 }];

function makeHandler(
  m: SkillManifest,
  d: Deps,
  resolveHost: DefaultCtxHandlerOptions["resolveHost"] = async () => PUBLIC_ADDRESS,
): DefaultCtxHandler {
  return new DefaultCtxHandler({
    resolveHost,
    manifest: m,
    runId: "run-1",
    user: { id: "user-1", timezone: "UTC" },
    memoryBankId: "bank-1",
    secretsStore: d.secretsStore,
    runInTx: fakeRunInTx,
    memory: d.memory,
    files: d.files,
    recordContextCall: d.recordContextCall,
    now: () => "2026-01-01T00:00:00.000Z",
  });
}

describe("DefaultCtxHandler", () => {
  describe("secrets.get", () => {
    it("returns the value when declared and present", async () => {
      const m = manifest("secrets:\n  - api_key");
      const d = deps();
      vi.mocked(d.secretsStore.getSecret).mockResolvedValue("sk-123");
      const h = makeHandler(m, d);

      const value = await h.handle({ method: "secrets.get", args: { name: "api_key" } });
      expect(value).toBe("sk-123");
      expect(d.recordContextCall).toHaveBeenCalledWith({
        runId: "run-1",
        method: "secrets.get",
        target: "api_key",
        ok: true,
        error: null,
      });
    });

    it("rejects an undeclared secret with not_in_allowlist", async () => {
      const m = manifest();
      const d = deps();
      const h = makeHandler(m, d);

      await expect(
        h.handle({ method: "secrets.get", args: { name: "api_key" } }),
      ).rejects.toMatchObject({ kind: "not_in_allowlist" });

      expect(d.recordContextCall).toHaveBeenCalledWith({
        runId: "run-1",
        method: "secrets.get",
        target: "api_key",
        ok: false,
        error: "not_in_allowlist",
      });
      // Crucially: never records the value.
      expect(d.secretsStore.getSecret).not.toHaveBeenCalled();
    });

    it("returns secret_not_found when the manifest declares it but the DB is empty", async () => {
      const m = manifest("secrets:\n  - api_key");
      const d = deps();
      vi.mocked(d.secretsStore.getSecret).mockResolvedValue(undefined);
      const h = makeHandler(m, d);

      await expect(
        h.handle({ method: "secrets.get", args: { name: "api_key" } }),
      ).rejects.toMatchObject({ kind: "secret_not_found" });
    });

    it("rejects malformed args with invalid_args", async () => {
      const m = manifest();
      const d = deps();
      const h = makeHandler(m, d);

      await expect(h.handle({ method: "secrets.get", args: {} })).rejects.toBeInstanceOf(CtxError);
    });
  });

  describe("http.request", () => {
    const okResponse = (body: string, status = 200) =>
      new Response(body, { status, headers: { "content-type": "application/json" } });

    it("returns status, headers and body for a successful request", async () => {
      const fetchMock = vi.spyOn(globalThis, "fetch").mockResolvedValue(okResponse('{"ok":1}'));
      try {
        const h = makeHandler(httpManifest(), deps());
        const out = await h.handle({
          method: "http.request",
          args: { method: "GET", url: "https://api.example.com/v1/things" },
        });
        expect(out).toMatchObject({ status: 200, body: '{"ok":1}' });
      } finally {
        fetchMock.mockRestore();
      }
    });

    it("audits origin and path but not the query, which carries credentials", async () => {
      const fetchMock = vi.spyOn(globalThis, "fetch").mockResolvedValue(okResponse("{}"));
      try {
        const d = deps();
        const h = makeHandler(httpManifest(), d);
        await h.handle({
          method: "http.request",
          args: { method: "GET", url: "https://api.example.com/v1/things?api_key=hunter2" },
        });
        expect(d.recordContextCall).toHaveBeenCalledWith(
          expect.objectContaining({
            method: "http.request",
            target: "https://api.example.com/v1/things",
            ok: true,
          }),
        );
        const recorded = JSON.stringify(vi.mocked(d.recordContextCall).mock.calls);
        expect(recorded).not.toContain("hunter2");
      } finally {
        fetchMock.mockRestore();
      }
    });

    it.each([
      ["127.0.0.1", 4],
      ["10.1.2.3", 4],
      ["172.20.0.5", 4],
      ["192.168.1.10", 4],
      ["169.254.169.254", 4],
      ["::1", 6],
      ["fd00::1", 6],
    ])(
      "refuses a host resolving to %s, which is the deployment's own network",
      async (address, family) => {
        // The host's `fetch` can see Hindsight, Inngest and cloud metadata;
        // a tier-2 skill in its remote sandbox cannot. Without this the
        // more-isolated tier would reach strictly further.
        const fetchMock = vi.spyOn(globalThis, "fetch");
        try {
          const d = deps();
          const h = makeHandler(httpManifest(), d, async () => [{ address, family }]);
          await expect(
            h.handle({
              method: "http.request",
              args: { method: "GET", url: "http://hindsight.internal:8888/v1/banks" },
            }),
          ).rejects.toThrow(/host's own network/);
          expect(fetchMock).not.toHaveBeenCalled();
          expect(d.recordContextCall).toHaveBeenCalledWith(
            expect.objectContaining({ ok: false, error: "blocked_destination" }),
          );
        } finally {
          fetchMock.mockRestore();
        }
      },
    );

    it.each([
      // Same loopback, four notations. Prefix matching on the text catches
      // only the first.
      ["0:0:0:0:0:0:0:1"],
      ["::0:0:1"],
      // v4-mapped loopback, dotted and hex.
      ["::ffff:127.0.0.1"],
      ["::ffff:7f00:1"],
      // Expanded unique-local and link-local.
      ["fd00:0:0:0:0:0:0:1"],
      ["fe80:0:0:0:0:0:0:1"],
      // IPv4-compatible, the other v4-in-v6 shape.
      ["::127.0.0.1"],
      ["::7f00:1"],
      // NAT64: a DNS64 resolver synthesises these from a private A record,
      // and the gateway translates them straight back.
      ["64:ff9b::7f00:1"],
      ["64:ff9b::a00:1"],
      // 6to4 carries the v4 address inline.
      ["2002:7f00:1::"],
      // Site-local, deprecated but still routed by some stacks.
      ["fec0::1"],
    ])("refuses %s, however it is written", async (address) => {
      const fetchMock = vi.spyOn(globalThis, "fetch");
      try {
        const h = makeHandler(httpManifest(), deps(), async () => [{ address, family: 6 }]);
        await expect(
          h.handle({
            method: "http.request",
            args: { method: "GET", url: "http://internal.example/x" },
          }),
        ).rejects.toThrow(/host's own network/);
        expect(fetchMock).not.toHaveBeenCalled();
      } finally {
        fetchMock.mockRestore();
      }
    });

    it.each([["2606:4700:4700::1111"], ["2001:db8::1"]])(
      "allows the public v6 address %s",
      async (address) => {
        const fetchMock = vi.spyOn(globalThis, "fetch").mockResolvedValue(okResponse("{}"));
        try {
          const h = makeHandler(httpManifest(), deps(), async () => [{ address, family: 6 }]);
          const out = await h.handle({
            method: "http.request",
            args: { method: "GET", url: "https://api.example.com/x" },
          });
          expect(out).toMatchObject({ status: 200 });
        } finally {
          fetchMock.mockRestore();
        }
      },
    );

    it("refuses an address it cannot parse rather than letting it through", async () => {
      const fetchMock = vi.spyOn(globalThis, "fetch");
      try {
        const h = makeHandler(httpManifest(), deps(), async () => [
          { address: "not:an:address:at:all:::", family: 6 },
        ]);
        await expect(
          h.handle({
            method: "http.request",
            args: { method: "GET", url: "http://weird.example/x" },
          }),
        ).rejects.toThrow(/host's own network/);
        expect(fetchMock).not.toHaveBeenCalled();
      } finally {
        fetchMock.mockRestore();
      }
    });

    it("refuses an IPv6-literal URL, which no allowlist entry can name", async () => {
      // `URL.hostname` keeps the brackets, and the allowlist grammar admits
      // names and IPv4 literals only, so the destination is unreachable by
      // construction rather than by address judgement.
      const seen: string[] = [];
      const fetchMock = vi.spyOn(globalThis, "fetch");
      try {
        const h = makeHandler(httpManifest(), deps(), async (hostname) => {
          seen.push(hostname);
          return [{ address: "::1", family: 6 }];
        });
        await expect(
          h.handle({ method: "http.request", args: { method: "GET", url: "http://[::1]:8888/x" } }),
        ).rejects.toThrow(/not in this skill's network\.allow list/);
        // Refused ahead of resolution, so it never became a DNS query.
        expect(seen).toEqual([]);
        expect(fetchMock).not.toHaveBeenCalled();
      } finally {
        fetchMock.mockRestore();
      }
    });

    it("bounds hostname resolution by the same deadline as the request", async () => {
      // `dns.lookup` takes no signal, so a resolver that never answers
      // would otherwise hold the call open past whatever was asked for.
      const fetchMock = vi.spyOn(globalThis, "fetch");
      try {
        const d = deps();
        const h = makeHandler(
          httpManifest(),
          d,
          () => new Promise(() => {}), // never resolves
        );
        await expect(
          h.handle({
            method: "http.request",
            args: { method: "GET", url: "https://slow-dns.example/x", timeoutMs: 20 },
          }),
        ).rejects.toThrow(/timed out/);
        expect(fetchMock).not.toHaveBeenCalled();
        // A resolver deadline is a timeout, not a transport failure —
        // one is worth retrying and the other usually is not.
        expect(d.recordContextCall).toHaveBeenCalledWith(
          expect.objectContaining({ ok: false, error: "timeout" }),
        );
      } finally {
        fetchMock.mockRestore();
      }
    });

    it("allows a host resolving to a public address", async () => {
      const fetchMock = vi.spyOn(globalThis, "fetch").mockResolvedValue(okResponse("{}"));
      try {
        const h = makeHandler(httpManifest(), deps());
        const out = await h.handle({
          method: "http.request",
          args: { method: "GET", url: "https://api.example.com/x" },
        });
        expect(out).toMatchObject({ status: 200 });
      } finally {
        fetchMock.mockRestore();
      }
    });

    it("does not follow redirects, so each destination is checked on its own call", async () => {
      // Following here would reach the next host without passing the
      // resolve check — the standard way around a guard like this.
      const fetchMock = vi
        .spyOn(globalThis, "fetch")
        .mockResolvedValue(
          new Response(null, { status: 302, headers: { location: "http://127.0.0.1:8888/" } }),
        );
      try {
        const h = makeHandler(httpManifest(), deps());
        const out = (await h.handle({
          method: "http.request",
          args: { method: "GET", url: "https://api.example.com/start" },
        })) as { status: number; headers: Record<string, string> };
        expect(out.status).toBe(302);
        expect(out.headers.location).toBe("http://127.0.0.1:8888/");
        expect(fetchMock).toHaveBeenCalledWith(
          expect.anything(),
          expect.objectContaining({ redirect: "manual" }),
        );
      } finally {
        fetchMock.mockRestore();
      }
    });

    it("holds the request timeout under the skill's wall clock", async () => {
      // A request allowed to outlive the terminator never surfaces as the
      // catchable error this method advertises — the worker just dies.
      const timeoutSpy = vi.spyOn(AbortSignal, "timeout");
      const fetchMock = vi.spyOn(globalThis, "fetch").mockResolvedValue(okResponse("{}"));
      try {
        const h = makeHandler(httpManifest("resources:\n  wall_clock_s: 20"), deps());
        await h.handle({
          method: "http.request",
          args: { method: "GET", url: "https://api.example.com/x", timeoutMs: 60_000 },
        });
        // 20s wall clock minus the 5s margin, not the 60s asked for. A
        // range, not an equality: the fetch deadline is the budget less
        // whatever resolution consumed, so an exact figure would flake.
        const asked = timeoutSpy.mock.calls.at(-1)?.[0] as number;
        expect(asked).toBeGreaterThan(14_000);
        expect(asked).toBeLessThanOrEqual(15_000);
      } finally {
        timeoutSpy.mockRestore();
        fetchMock.mockRestore();
      }
    });

    it("returns the response headers, which callers need for content-type", async () => {
      const fetchMock = vi.spyOn(globalThis, "fetch").mockResolvedValue(okResponse("{}"));
      try {
        const h = makeHandler(httpManifest(), deps());
        const out = (await h.handle({
          method: "http.request",
          args: { method: "GET", url: "https://api.example.com/x" },
        })) as { headers: Record<string, string> };
        expect(out.headers["content-type"]).toBe("application/json");
      } finally {
        fetchMock.mockRestore();
      }
    });

    it("classifies a request timeout apart from other transport failures", async () => {
      // What `AbortSignal.timeout` raises — the distinction matters
      // because a timeout is worth retrying and a refused connection
      // usually is not.
      const timeout = new Error("The operation was aborted due to timeout");
      timeout.name = "TimeoutError";
      const fetchMock = vi.spyOn(globalThis, "fetch").mockRejectedValue(timeout);
      try {
        const d = deps();
        const h = makeHandler(httpManifest(), d);
        await expect(
          h.handle({
            method: "http.request",
            args: { method: "GET", url: "https://api.example.com/slow" },
          }),
        ).rejects.toThrow(/failed/);
        expect(d.recordContextCall).toHaveBeenCalledWith(
          expect.objectContaining({ ok: false, error: "timeout" }),
        );
      } finally {
        fetchMock.mockRestore();
      }
    });

    it("keeps the timeout classification when the body stalls mid-read", async () => {
      const timeout = new Error("The operation was aborted due to timeout");
      timeout.name = "TimeoutError";
      const stream = new ReadableStream<Uint8Array>({
        start(controller) {
          controller.enqueue(new Uint8Array([1, 2, 3]));
          controller.error(timeout);
        },
      });
      const fetchMock = vi
        .spyOn(globalThis, "fetch")
        .mockResolvedValue(new Response(stream, { status: 200 }));
      try {
        const d = deps();
        const h = makeHandler(httpManifest(), d);
        await expect(
          h.handle({
            method: "http.request",
            args: { method: "GET", url: "https://api.example.com/stall" },
          }),
        ).rejects.toThrow(/mid-body/);
        expect(d.recordContextCall).toHaveBeenCalledWith(
          expect.objectContaining({ ok: false, error: "timeout" }),
        );
      } finally {
        fetchMock.mockRestore();
      }
    });

    it("returns an empty body for a 204 with no content", async () => {
      const fetchMock = vi
        .spyOn(globalThis, "fetch")
        .mockResolvedValue(new Response(null, { status: 204 }));
      try {
        const h = makeHandler(httpManifest(), deps());
        const out = await h.handle({
          method: "http.request",
          args: { method: "DELETE", url: "https://api.example.com/thing" },
        });
        expect(out).toMatchObject({ status: 204, body: "" });
      } finally {
        fetchMock.mockRestore();
      }
    });

    it("hands back a 4xx as a value rather than throwing", async () => {
      const fetchMock = vi
        .spyOn(globalThis, "fetch")
        .mockResolvedValue(okResponse("not found", 404));
      try {
        const h = makeHandler(httpManifest(), deps());
        const out = await h.handle({
          method: "http.request",
          args: { method: "GET", url: "https://api.example.com/missing" },
        });
        expect(out).toMatchObject({ status: 404, body: "not found" });
      } finally {
        fetchMock.mockRestore();
      }
    });

    it.each([["file:///etc/passwd"], ["data:text/plain,hi"]])(
      "refuses the non-HTTP scheme in %s, which would read the host instead",
      async (url) => {
        const fetchMock = vi.spyOn(globalThis, "fetch");
        try {
          const h = makeHandler(httpManifest(), deps());
          await expect(
            h.handle({ method: "http.request", args: { method: "GET", url } }),
          ).rejects.toThrow(/supports http and https/);
          expect(fetchMock).not.toHaveBeenCalled();
        } finally {
          fetchMock.mockRestore();
        }
      },
    );

    it("refuses a response past the byte cap instead of decoding it", async () => {
      const chunk = new Uint8Array(1024 * 1024);
      const stream = new ReadableStream<Uint8Array>({
        start(controller) {
          for (let i = 0; i < 8; i++) controller.enqueue(chunk);
          controller.close();
        },
      });
      const fetchMock = vi
        .spyOn(globalThis, "fetch")
        .mockResolvedValue(new Response(stream, { status: 200 }));
      try {
        const h = makeHandler(httpManifest(), deps());
        await expect(
          h.handle({
            method: "http.request",
            args: { method: "GET", url: "https://api.example.com/big" },
          }),
        ).rejects.toThrow(/exceeded/);
      } finally {
        fetchMock.mockRestore();
      }
    });

    it("surfaces a transport failure as a typed error naming the target", async () => {
      const fetchMock = vi.spyOn(globalThis, "fetch").mockRejectedValue(new Error("ECONNREFUSED"));
      try {
        const d = deps();
        const h = makeHandler(httpManifest(), d);
        await expect(
          h.handle({
            method: "http.request",
            args: { method: "GET", url: "https://api.example.com/x" },
          }),
        ).rejects.toThrow(/api\.example\.com/);
        expect(d.recordContextCall).toHaveBeenCalledWith(
          expect.objectContaining({ ok: false, error: "network_error" }),
        );
      } finally {
        fetchMock.mockRestore();
      }
    });

    it("rejects a malformed request shape", async () => {
      const h = makeHandler(httpManifest(), deps());
      await expect(
        h.handle({ method: "http.request", args: { url: "https://example.com" } }),
      ).rejects.toThrow(/expects/);
    });

    describe("network allowlist", () => {
      const publicAddress = async () => [{ address: "93.184.216.34", family: 4 }];

      it("refuses every destination when the manifest declares no network block", async () => {
        const seen: string[] = [];
        const fetchMock = vi.spyOn(globalThis, "fetch");
        try {
          const h = makeHandler(manifest(""), deps(), async (hostname) => {
            seen.push(hostname);
            return [{ address: "93.184.216.34", family: 4 }];
          });
          await expect(
            h.handle({
              method: "http.request",
              args: { method: "GET", url: "https://api.example.com/v1" },
            }),
          ).rejects.toThrow(/declares no 'network:' block/);
          // Ahead of resolution, so a destination the skill never declared
          // does not even leak as a DNS query.
          expect(seen).toEqual([]);
          expect(fetchMock).not.toHaveBeenCalled();
        } finally {
          fetchMock.mockRestore();
        }
      });

      it("records a refused destination in the audit as not_in_allowlist", async () => {
        const d = deps();
        const h = makeHandler(manifest(""), d, publicAddress);
        await expect(
          h.handle({
            method: "http.request",
            args: { method: "GET", url: "https://api.example.com/v1" },
          }),
        ).rejects.toThrow();
        expect(d.recordContextCall).toHaveBeenCalledWith(
          expect.objectContaining({
            method: "http.request",
            target: "https://api.example.com/v1",
            ok: false,
            error: "not_in_allowlist",
          }),
        );
      });

      it("refuses a host the allowlist does not name", async () => {
        const fetchMock = vi.spyOn(globalThis, "fetch");
        try {
          const h = makeHandler(httpManifest(), deps(), publicAddress);
          await expect(
            h.handle({
              method: "http.request",
              args: { method: "GET", url: "https://evil.example.net/collect" },
            }),
          ).rejects.toThrow(/'evil\.example\.net' is not in this skill's network\.allow list/);
          expect(fetchMock).not.toHaveBeenCalled();
        } finally {
          fetchMock.mockRestore();
        }
      });

      it("admits a subdomain under a '*.' entry", async () => {
        const fetchMock = vi.spyOn(globalThis, "fetch").mockResolvedValue(okResponse("{}"));
        try {
          const h = makeHandler(
            manifest("network:\n  allow:\n    - '*.example.com'"),
            deps(),
            publicAddress,
          );
          const out = await h.handle({
            method: "http.request",
            args: { method: "GET", url: "https://api.example.com/v1" },
          });
          expect(out).toMatchObject({ status: 200 });
        } finally {
          fetchMock.mockRestore();
        }
      });

      it("does not read a '*.' entry as covering the apex", async () => {
        const fetchMock = vi.spyOn(globalThis, "fetch");
        try {
          const h = makeHandler(
            manifest("network:\n  allow:\n    - '*.example.com'"),
            deps(),
            publicAddress,
          );
          await expect(
            h.handle({
              method: "http.request",
              args: { method: "GET", url: "https://example.com/v1" },
            }),
          ).rejects.toThrow(/not in this skill's network\.allow list/);
          expect(fetchMock).not.toHaveBeenCalled();
        } finally {
          fetchMock.mockRestore();
        }
      });

      it("does not let a '*.' entry match a host that merely ends in the same text", async () => {
        const fetchMock = vi.spyOn(globalThis, "fetch");
        try {
          const h = makeHandler(
            manifest("network:\n  allow:\n    - '*.example.com'"),
            deps(),
            publicAddress,
          );
          await expect(
            h.handle({
              method: "http.request",
              args: { method: "GET", url: "https://notexample.com/v1" },
            }),
          ).rejects.toThrow(/not in this skill's network\.allow list/);
          expect(fetchMock).not.toHaveBeenCalled();
        } finally {
          fetchMock.mockRestore();
        }
      });

      it("matches case-insensitively, since hostnames are", async () => {
        const fetchMock = vi.spyOn(globalThis, "fetch").mockResolvedValue(okResponse("{}"));
        try {
          const h = makeHandler(
            manifest("network:\n  allow:\n    - API.Example.COM"),
            deps(),
            publicAddress,
          );
          const out = await h.handle({
            method: "http.request",
            args: { method: "GET", url: "https://api.example.com/v1" },
          });
          expect(out).toMatchObject({ status: 200 });
        } finally {
          fetchMock.mockRestore();
        }
      });

      it("still refuses a declared host that resolves onto the host's own network", async () => {
        // The two checks answer different questions: the allowlist bounds
        // where a skill may reach, the address guard bounds what a permitted
        // name may point at. Declaring a host does not buy past the second.
        const h = makeHandler(httpManifest(), deps(), async () => [
          { address: "127.0.0.1", family: 4 },
        ]);
        await expect(
          h.handle({
            method: "http.request",
            args: { method: "GET", url: "https://api.example.com/v1" },
          }),
        ).rejects.toThrow(/host's own network/);
      });
    });
  });

  describe("memory.recall / memory.remember", () => {
    it("recall requires the reads_memory effect", async () => {
      const m = manifest();
      const d = deps();
      const h = makeHandler(m, d);

      await expect(
        h.handle({ method: "memory.recall", args: { query: "hello" } }),
      ).rejects.toMatchObject({ kind: "missing_effect" });
    });

    it("recall returns memories when effect is declared", async () => {
      const m = manifest("effects:\n  - reads_memory");
      const d = deps();
      vi.mocked(d.memory.recall).mockResolvedValue({
        memories: [{ content: "fact", type: "world", metadata: {} }],
      });
      const h = makeHandler(m, d);

      const value = await h.handle({ method: "memory.recall", args: { query: "hello" } });
      expect(value).toEqual({ memories: [{ content: "fact", type: "world" }] });
      expect(d.recordContextCall).toHaveBeenCalledWith({
        runId: "run-1",
        method: "memory.recall",
        target: null,
        ok: true,
        error: null,
      });
    });

    it("remember requires the writes_memory effect", async () => {
      const m = manifest();
      const d = deps();
      const h = makeHandler(m, d);

      await expect(
        h.handle({ method: "memory.remember", args: { content: "x" } }),
      ).rejects.toMatchObject({ kind: "missing_effect" });
    });

    it("remember calls retain when effect is declared", async () => {
      const m = manifest("effects:\n  - writes_memory");
      const d = deps();
      const h = makeHandler(m, d);

      await h.handle({
        method: "memory.remember",
        args: { content: "remember this", tags: ["world"] },
      });
      expect(d.memory.retain).toHaveBeenCalledWith("bank-1", "remember this", {
        tags: ["world"],
      });
    });
  });

  describe("files.read / files.write / files.list", () => {
    it("read requires the reads_filesystem effect", async () => {
      const m = manifest();
      const d = deps();
      const h = makeHandler(m, d);

      await expect(
        h.handle({ method: "files.read", args: { path: "notes/x.md" } }),
      ).rejects.toMatchObject({ kind: "missing_effect" });
      expect(d.files.read).not.toHaveBeenCalled();
      expect(d.recordContextCall).toHaveBeenCalledWith({
        runId: "run-1",
        method: "files.read",
        target: "notes/x.md",
        ok: false,
        error: "missing_effect",
      });
    });

    it("read returns the workspace content when effect is declared", async () => {
      const m = manifest("effects:\n  - reads_filesystem");
      const d = deps();
      vi.mocked(d.files.read).mockResolvedValue("hello");
      const h = makeHandler(m, d);

      const value = await h.handle({ method: "files.read", args: { path: "notes/x.md" } });
      expect(value).toBe("hello");
      expect(d.files.read).toHaveBeenCalledWith("notes/x.md");
      expect(d.recordContextCall).toHaveBeenCalledWith({
        runId: "run-1",
        method: "files.read",
        target: "notes/x.md",
        ok: true,
        error: null,
      });
    });

    it("read surfaces backend failures as read_failed", async () => {
      const m = manifest("effects:\n  - reads_filesystem");
      const d = deps();
      vi.mocked(d.files.read).mockRejectedValue(new Error("File not found: notes/x.md"));
      const h = makeHandler(m, d);

      await expect(
        h.handle({ method: "files.read", args: { path: "notes/x.md" } }),
      ).rejects.toMatchObject({ kind: "read_failed" });
      expect(d.recordContextCall).toHaveBeenCalledWith({
        runId: "run-1",
        method: "files.read",
        target: "notes/x.md",
        ok: false,
        error: "read_failed",
      });
    });

    it("write requires the writes_filesystem effect", async () => {
      const m = manifest();
      const d = deps();
      const h = makeHandler(m, d);

      await expect(
        h.handle({
          method: "files.write",
          args: { path: "notes/x.md", content: "hi" },
        }),
      ).rejects.toMatchObject({ kind: "missing_effect" });
      expect(d.files.write).not.toHaveBeenCalled();
    });

    it("write surfaces backend failures as write_failed", async () => {
      const m = manifest("effects:\n  - writes_filesystem");
      const d = deps();
      vi.mocked(d.files.write).mockRejectedValue(new Error("S3 5xx"));
      const h = makeHandler(m, d);

      await expect(
        h.handle({
          method: "files.write",
          args: { path: "notes/x.md", content: "hi" },
        }),
      ).rejects.toMatchObject({ kind: "write_failed" });
      expect(d.recordContextCall).toHaveBeenCalledWith({
        runId: "run-1",
        method: "files.write",
        target: "notes/x.md",
        ok: false,
        error: "write_failed",
      });
    });

    it("list surfaces backend failures as list_failed", async () => {
      const m = manifest("effects:\n  - reads_filesystem");
      const d = deps();
      vi.mocked(d.files.list).mockRejectedValue(new Error("S3 listing timeout"));
      const h = makeHandler(m, d);

      await expect(
        h.handle({ method: "files.list", args: { prefix: "notes/" } }),
      ).rejects.toMatchObject({ kind: "list_failed" });
      expect(d.recordContextCall).toHaveBeenCalledWith({
        runId: "run-1",
        method: "files.list",
        target: "notes/",
        ok: false,
        error: "list_failed",
      });
    });

    it("write persists when effect is declared", async () => {
      const m = manifest("effects:\n  - writes_filesystem");
      const d = deps();
      const h = makeHandler(m, d);

      const r = await h.handle({
        method: "files.write",
        args: { path: "notes/x.md", content: "draft v1" },
      });
      expect(r).toBeNull();
      expect(d.files.write).toHaveBeenCalledWith("notes/x.md", "draft v1");
      expect(d.recordContextCall).toHaveBeenCalledWith({
        runId: "run-1",
        method: "files.write",
        target: "notes/x.md",
        ok: true,
        error: null,
      });
    });

    it("list requires the reads_filesystem effect", async () => {
      const m = manifest();
      const d = deps();
      const h = makeHandler(m, d);

      await expect(
        h.handle({ method: "files.list", args: { prefix: "notes/" } }),
      ).rejects.toMatchObject({ kind: "missing_effect" });
      expect(d.files.list).not.toHaveBeenCalled();
    });

    it("list returns entries with last_modified as ISO-8601", async () => {
      const m = manifest("effects:\n  - reads_filesystem");
      const d = deps();
      const lastModified = new Date("2026-04-01T12:00:00.000Z");
      vi.mocked(d.files.list).mockResolvedValue([
        { path: "notes/a.md", size: 42, lastModified },
        { path: "notes/b.md", size: 7, lastModified },
      ]);
      const h = makeHandler(m, d);

      const value = await h.handle({ method: "files.list", args: { prefix: "notes/" } });
      expect(value).toEqual({
        entries: [
          { path: "notes/a.md", size: 42, last_modified: "2026-04-01T12:00:00.000Z" },
          { path: "notes/b.md", size: 7, last_modified: "2026-04-01T12:00:00.000Z" },
        ],
      });
      expect(d.files.list).toHaveBeenCalledWith("notes/");
    });

    it("list with no prefix passes undefined to the backend", async () => {
      const m = manifest("effects:\n  - reads_filesystem");
      const d = deps();
      const h = makeHandler(m, d);

      await h.handle({ method: "files.list", args: {} });
      expect(d.files.list).toHaveBeenCalledWith(undefined);
    });

    it("rejects malformed args with invalid_args", async () => {
      const m = manifest("effects:\n  - reads_filesystem\n  - writes_filesystem");
      const d = deps();
      const h = makeHandler(m, d);

      await expect(h.handle({ method: "files.read", args: {} })).rejects.toMatchObject({
        kind: "invalid_args",
      });
      await expect(h.handle({ method: "files.write", args: { path: "x" } })).rejects.toMatchObject({
        kind: "invalid_args",
      });
    });
  });

  describe("now / user / log.info", () => {
    it("now returns the injected clock value", async () => {
      const h = makeHandler(manifest(), deps());
      expect(await h.handle({ method: "now", args: {} })).toBe("2026-01-01T00:00:00.000Z");
    });

    it("user returns the injected user", async () => {
      const h = makeHandler(manifest(), deps());
      expect(await h.handle({ method: "user", args: {} })).toEqual({
        id: "user-1",
        timezone: "UTC",
      });
    });

    it("log.info accepts a plain message", async () => {
      const d = deps();
      const h = makeHandler(manifest(), d);
      const r = await h.handle({ method: "log.info", args: { message: "hello" } });
      expect(r).toBeNull();
      expect(d.recordContextCall).toHaveBeenCalledWith({
        runId: "run-1",
        method: "log.info",
        target: null,
        ok: true,
        error: null,
      });
    });
  });

  it("rejects an unknown method", async () => {
    const h = makeHandler(manifest(), deps());
    await expect(h.handle({ method: "evil.delete", args: {} })).rejects.toMatchObject({
      kind: "unknown_method",
    });
  });

  describe("argument validation boundaries", () => {
    it("secrets.get with empty name is invalid_args (not allowlist)", async () => {
      const m = manifest("secrets:\n  - api_key");
      const d = deps();
      const h = makeHandler(m, d);
      await expect(h.handle({ method: "secrets.get", args: { name: "" } })).rejects.toMatchObject({
        kind: "invalid_args",
      });
    });

    it("memory.recall query='' is invalid_args", async () => {
      const m = manifest("effects:\n  - reads_memory");
      const h = makeHandler(m, deps());
      await expect(
        h.handle({ method: "memory.recall", args: { query: "" } }),
      ).rejects.toMatchObject({ kind: "invalid_args" });
    });

    it("memory.recall limit=0 is invalid_args", async () => {
      const m = manifest("effects:\n  - reads_memory");
      const h = makeHandler(m, deps());
      await expect(
        h.handle({ method: "memory.recall", args: { query: "x", limit: 0 } }),
      ).rejects.toMatchObject({ kind: "invalid_args" });
    });

    it("memory.recall limit=51 is invalid_args (max 50)", async () => {
      const m = manifest("effects:\n  - reads_memory");
      const h = makeHandler(m, deps());
      await expect(
        h.handle({ method: "memory.recall", args: { query: "x", limit: 51 } }),
      ).rejects.toMatchObject({ kind: "invalid_args" });
    });

    it("memory.recall limit=1.5 is invalid_args (must be integer)", async () => {
      const m = manifest("effects:\n  - reads_memory");
      const h = makeHandler(m, deps());
      await expect(
        h.handle({ method: "memory.recall", args: { query: "x", limit: 1.5 } }),
      ).rejects.toMatchObject({ kind: "invalid_args" });
    });

    it("memory.remember content='' is invalid_args", async () => {
      const m = manifest("effects:\n  - writes_memory");
      const h = makeHandler(m, deps());
      await expect(
        h.handle({ method: "memory.remember", args: { content: "" } }),
      ).rejects.toMatchObject({ kind: "invalid_args" });
    });

    it("memory.remember tags=[''] is invalid_args (each tag must be non-empty)", async () => {
      const m = manifest("effects:\n  - writes_memory");
      const h = makeHandler(m, deps());
      await expect(
        h.handle({ method: "memory.remember", args: { content: "x", tags: [""] } }),
      ).rejects.toMatchObject({ kind: "invalid_args" });
    });

    it("memory.remember without tags omits the tags field on retain", async () => {
      const m = manifest("effects:\n  - writes_memory");
      const d = deps();
      const h = makeHandler(m, d);
      await h.handle({ method: "memory.remember", args: { content: "x" } });
      expect(d.memory.retain).toHaveBeenCalledWith("bank-1", "x", {});
    });

    it("log.info accepts structured fields and emits them on the pino child", async () => {
      const d = deps();
      const h = makeHandler(manifest(), d);
      await h.handle({
        method: "log.info",
        args: { message: "hello", fields: { foo: 1, bar: "two" } },
      });
      // Verifying actual pino output is fragile; assert the audit row
      // happened, which means dispatch reached `log.info` successfully.
      expect(d.recordContextCall).toHaveBeenCalledWith({
        runId: "run-1",
        method: "log.info",
        target: null,
        ok: true,
        error: null,
      });
    });

    it("log.info with empty message accepted (z.string() allows empty)", async () => {
      const h = makeHandler(manifest(), deps());
      const r = await h.handle({ method: "log.info", args: { message: "" } });
      expect(r).toBeNull();
    });
  });

  describe("audit invariant", () => {
    it("missing_effect path does NOT call the underlying memory provider", async () => {
      const m = manifest();
      const d = deps();
      const h = makeHandler(m, d);
      await expect(
        h.handle({ method: "memory.recall", args: { query: "hello" } }),
      ).rejects.toMatchObject({ kind: "missing_effect" });
      expect(d.memory.recall).not.toHaveBeenCalled();
    });

    it("missing_effect on memory.remember does NOT call retain", async () => {
      const m = manifest();
      const d = deps();
      const h = makeHandler(m, d);
      await expect(
        h.handle({ method: "memory.remember", args: { content: "x" } }),
      ).rejects.toMatchObject({ kind: "missing_effect" });
      expect(d.memory.retain).not.toHaveBeenCalled();
    });

    it("unknown_method audit row carries the original method string", async () => {
      const d = deps();
      const h = makeHandler(manifest(), d);
      await expect(h.handle({ method: "evil.delete", args: {} })).rejects.toMatchObject({
        kind: "unknown_method",
      });
      expect(d.recordContextCall).toHaveBeenCalledWith({
        runId: "run-1",
        method: "evil.delete",
        target: null,
        ok: false,
        error: "unknown_method",
      });
    });

    it("recordContextCall throwing is swallowed (the call still returns/throws as expected)", async () => {
      const d = deps();
      vi.mocked(d.recordContextCall).mockRejectedValue(new Error("audit DB down"));
      const m = manifest();
      const h = makeHandler(m, d);
      // The success path: now() — even if audit fails, return value is correct.
      const r = await h.handle({ method: "now", args: {} });
      expect(r).toBe("2026-01-01T00:00:00.000Z");
    });
  });

  describe("secrets allowlist union form", () => {
    it("accepts a secret declared in object form", async () => {
      const m = manifest(
        `secrets:\n  - name: scoped\n    binding:\n      destination: "https://x.com/*"`,
      );
      const d = deps();
      vi.mocked(d.secretsStore.getSecret).mockResolvedValue("v");
      const h = makeHandler(m, d);
      const r = await h.handle({ method: "secrets.get", args: { name: "scoped" } });
      expect(r).toBe("v");
    });

    it("treats string-form and object-form declarations equivalently in the allowlist", async () => {
      const m = manifest(
        `secrets:\n  - bare\n  - name: object_form\n    binding:\n      destination: "https://x.com/*"`,
      );
      const d = deps();
      vi.mocked(d.secretsStore.getSecret).mockImplementation(async (_tx, name) =>
        name === "bare" ? "BARE" : name === "object_form" ? "OBJ" : null,
      );
      const h = makeHandler(m, d);
      expect(await h.handle({ method: "secrets.get", args: { name: "bare" } })).toBe("BARE");
      expect(await h.handle({ method: "secrets.get", args: { name: "object_form" } })).toBe("OBJ");
    });
  });
});
