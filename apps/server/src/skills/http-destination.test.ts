import { describe, expect, it } from "vitest";
import { hostAllowed, parseHttpUrl } from "./http-destination.js";

describe("parseHttpUrl", () => {
  it("parses an http or https URL as WHATWG does", () => {
    const parsed = parseHttpUrl("HTTPS://API.Example.com:8443/a/../b?q=1");
    expect(parsed._unsafeUnwrap().hostname).toBe("api.example.com");
    expect(parsed._unsafeUnwrap().pathname).toBe("/b");
  });

  it.each([
    ["no scheme", "api.example.com/x"],
    ["a port out of range", "https://api.example.com:99999/"],
    ["a space in the host", "https://exa mple.com/"],
  ])("refuses a URL with %s as unparseable", (_label, url) => {
    expect(parseHttpUrl(url)._unsafeUnwrapErr()).toEqual({ kind: "unparseable" });
  });

  it.each([
    ["file:///etc/passwd", "file:"],
    ["data:text/plain,hi", "data:"],
    ["ftp://api.example.com/", "ftp:"],
  ])("refuses %s as not http", (url, protocol) => {
    expect(parseHttpUrl(url)._unsafeUnwrapErr()).toEqual({ kind: "not_http", protocol });
  });
});

describe("hostAllowed", () => {
  it.each([
    ["an exact entry", "api.example.com", ["api.example.com"], true],
    ["a wildcard one label deep", "api.example.com", ["*.example.com"], true],
    ["a wildcard at any depth", "a.b.example.com", ["*.example.com"], true],
    ["a wildcard's apex, not implied", "example.com", ["*.example.com"], false],
    ["a suffix that is not a label", "evilexample.com", ["*.example.com"], false],
    ["an entry in another case", "api.example.com", ["API.Example.COM"], true],
    ["a hostname in another case", "API.EXAMPLE.COM", ["api.example.com"], true],
    ["an empty list", "api.example.com", [], false],
  ])("matches %s", (_label, host, allow, expected) => {
    expect(hostAllowed(host, allow)).toBe(expected);
  });
});
