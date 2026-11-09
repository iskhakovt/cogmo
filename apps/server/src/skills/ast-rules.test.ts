import { describe, expect, it } from "vitest";
import { admitsWriteEndpoint, isWriteRequest, type RequestPath } from "./ast-rules.js";

const literal = (path: string): RequestPath => ({ kind: "literal", path });
const TEMPLATED: RequestPath = { kind: "templated" };

describe("isWriteRequest", () => {
  it.each(["POST", "PUT", "PATCH", "DELETE", "HEAD"])("reads %s as a write anywhere", (method) => {
    expect(isWriteRequest(method, "api.example.com", literal("/x"))).toBe(true);
  });

  it.each([
    ["a send method", "/bot1:abc/sendMessage", true],
    ["an edit method", "/bot1:abc/editMessageText", true],
    ["a delete method", "/bot1:abc/deleteMessage", true],
    ["a method in another case", "/BOT1:abc/SENDPHOTO", true],
    ["a read method", "/bot1:abc/getUpdates", false],
    ["a file download", "/file/bot1:abc/sendMessage", false],
    ["a send method a segment deeper", "/bot1/extra/sendMessage", false],
    ["a send method with a trailing segment", "/bot1/sendMessage/x", false],
    ["a percent-encoded send method", "/bot123/%73endMessage", true],
    ["a percent-encoded method in another case", "/bot123/%45DIT%4dessageText", true],
    ["a percent-encoded read method", "/bot123/%67etMe", false],
    ["an escape of a byte outside ASCII", "/bot123/send%C3%A9", true],
  ])("reads a Telegram GET to %s by its literal path", (_label, path, expected) => {
    expect(isWriteRequest("GET", "api.telegram.org", literal(path))).toBe(expected);
  });

  it("reads a Telegram GET to a templated path as a write, since a field can form any endpoint", () => {
    expect(isWriteRequest("GET", "API.Telegram.org", TEMPLATED)).toBe(true);
  });

  it.each([
    ["a literal send path", literal("/bot1/sendMessage")],
    ["a templated path", TEMPLATED],
  ])("reads a GET to %s on a host with no write endpoints as a read", (_label, path) => {
    expect(isWriteRequest("GET", "api.example.com", path)).toBe(false);
  });
});

describe("admitsWriteEndpoint", () => {
  it.each([
    [["api.telegram.org"], true],
    [["*.telegram.org"], true],
    [["telegram.org", "api.example.com"], false],
  ])("for %o is %s", (allow, expected) => {
    expect(admitsWriteEndpoint(allow)).toBe(expected);
  });
});
