import { describe, expect, it } from "vitest";
import {
  buildClearCookie,
  buildSessionCookie,
  parseCookies,
  sessionCookieName,
} from "./cookies.js";

describe("parseCookies", () => {
  it("parses a multi-cookie header", () => {
    expect(parseCookies("a=1; __Host-session=tok; b=2")).toEqual({
      a: "1",
      "__Host-session": "tok",
      b: "2",
    });
  });

  it("returns empty for a missing header", () => {
    expect(parseCookies(undefined)).toEqual({});
  });

  it("url-decodes values", () => {
    expect(parseCookies("x=a%20b")).toEqual({ x: "a b" });
  });

  it("falls back to the raw value on a malformed percent-encoding", () => {
    // A bad cookie from another app on the host must not throw (would 500 the request).
    expect(parseCookies("x=%zz; __Host-session=ok")).toEqual({
      x: "%zz",
      "__Host-session": "ok",
    });
  });
});

describe("sessionCookieName", () => {
  it("uses the __Host- prefix when secure", () => {
    expect(sessionCookieName(true)).toBe("__Host-session");
  });

  it("drops the prefix in insecure dev mode", () => {
    expect(sessionCookieName(false)).toBe("session");
  });
});

describe("buildSessionCookie", () => {
  it("hardens with __Host- + Secure + HttpOnly + SameSite=Strict when secure", () => {
    const c = buildSessionCookie("tok", { secure: true, maxAgeSeconds: 100 });
    expect(c).toContain("__Host-session=tok");
    expect(c).toContain("Path=/");
    expect(c).toContain("HttpOnly");
    expect(c).toContain("SameSite=Strict");
    expect(c).toContain("Max-Age=100");
    expect(c).toContain("Secure");
  });

  it("omits Secure and the prefix in insecure dev mode", () => {
    const c = buildSessionCookie("tok", { secure: false, maxAgeSeconds: 100 });
    expect(c).toContain("session=tok");
    expect(c).not.toContain("__Host-");
    expect(c).not.toContain("Secure");
    expect(c).toContain("HttpOnly");
  });
});

describe("buildClearCookie", () => {
  it("expires the cookie immediately", () => {
    expect(buildClearCookie({ secure: true })).toContain("Max-Age=0");
  });
});
