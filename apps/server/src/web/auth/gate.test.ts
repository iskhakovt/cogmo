import type { IncomingMessage } from "node:http";
import { describe, expect, it, vi } from "vitest";
import { mock } from "vitest-mock-extended";
import { authenticate, cookieStrategy, csrfReject } from "./gate.js";

function req(method: string, headers: Record<string, string | undefined>): IncomingMessage {
  const r = mock<IncomingMessage>();
  r.method = method;
  r.headers = headers;
  return r;
}

describe("csrfReject", () => {
  it("passes safe methods (GET)", () => {
    expect(csrfReject(req("GET", {}))).toBe(false);
  });

  it("passes a same-origin JSON POST", () => {
    expect(
      csrfReject(
        req("POST", { "sec-fetch-site": "same-origin", "content-type": "application/json" }),
      ),
    ).toBe(false);
  });

  it("rejects a state-changing request with no origin proof", () => {
    expect(csrfReject(req("POST", { "content-type": "application/json" }))).toBe(true);
  });

  it("rejects a cross-site POST", () => {
    expect(
      csrfReject(
        req("POST", { "sec-fetch-site": "cross-site", "content-type": "application/json" }),
      ),
    ).toBe(true);
  });

  it("rejects a same-origin POST that isn't application/json", () => {
    expect(
      csrfReject(req("POST", { "sec-fetch-site": "same-origin", "content-type": "text/plain" })),
    ).toBe(true);
  });

  it("accepts an exact Origin match when sec-fetch-site is absent", () => {
    expect(
      csrfReject(
        req("POST", {
          origin: "https://cogmo.example",
          host: "cogmo.example",
          "content-type": "application/json",
        }),
      ),
    ).toBe(false);
  });

  it("rejects a mismatched Origin", () => {
    expect(
      csrfReject(
        req("POST", {
          origin: "https://evil.example",
          host: "cogmo.example",
          "content-type": "application/json",
        }),
      ),
    ).toBe(true);
  });

  it("accepts a same-hostname Origin despite a port mismatch (TLS-terminating proxy)", () => {
    // No Sec-Fetch-Site (legacy browser) -> Origin host fallback, hostname-only.
    expect(
      csrfReject(
        req("POST", {
          origin: "https://cogmo.example",
          host: "cogmo.example:9090",
          "content-type": "application/json",
        }),
      ),
    ).toBe(false);
  });

  it("rejects a same-site request (sibling-port origin) even when the hostname matches", () => {
    // Modern browser: Sec-Fetch-Site is authoritative and port-aware, so a
    // same-hostname-different-port origin ("same-site", not "same-origin") is
    // rejected despite the Origin hostname matching the Host.
    expect(
      csrfReject(
        req("POST", {
          "sec-fetch-site": "same-site",
          origin: "https://cogmo.example:8080",
          host: "cogmo.example:9090",
          "content-type": "application/json",
        }),
      ),
    ).toBe(true);
  });

  it("rejects a cross-hostname Origin regardless of port", () => {
    expect(
      csrfReject(
        req("POST", {
          origin: "https://evil.example:9090",
          host: "cogmo.example:9090",
          "content-type": "application/json",
        }),
      ),
    ).toBe(true);
  });

  it("origin-gates DELETE but skips its content-type", () => {
    expect(csrfReject(req("DELETE", { "sec-fetch-site": "same-origin" }))).toBe(false);
    expect(csrfReject(req("DELETE", { "sec-fetch-site": "cross-site" }))).toBe(true);
  });
});

describe("authenticate + cookieStrategy", () => {
  const strategies = (resolveSession: (t: string) => Promise<{ userId: string } | null>) => [
    cookieStrategy({ cookieName: "__Host-session", ownerHandle: "web-owner", resolveSession }),
  ];

  it("resolves the owner when the cookie maps to a session", async () => {
    const resolveSession = vi.fn(async () => ({ userId: "u1" }));
    const id = await authenticate(
      req("GET", { cookie: "__Host-session=raw" }),
      strategies(resolveSession),
    );
    expect(id).toEqual({ userId: "u1", platformUserHandle: "web-owner" });
    expect(resolveSession).toHaveBeenCalledWith("raw");
  });

  it("returns null when no cookie is present (fail-closed)", async () => {
    expect(
      await authenticate(
        req("GET", {}),
        strategies(async () => ({ userId: "u1" })),
      ),
    ).toBeNull();
  });

  it("returns null when the session doesn't resolve", async () => {
    expect(
      await authenticate(
        req("GET", { cookie: "__Host-session=raw" }),
        strategies(async () => null),
      ),
    ).toBeNull();
  });
});
