import { createHash } from "node:crypto";
import { describe, expect, it } from "vitest";
import { hashConnectorToken, newConnectorToken } from "./token.js";

describe("newConnectorToken", () => {
  it("mints 32 random bytes as base64url", () => {
    const { rawToken } = newConnectorToken();
    expect(rawToken).toMatch(/^[A-Za-z0-9_-]{43}$/);
    expect(Buffer.from(rawToken, "base64url")).toHaveLength(32);
  });

  it("returns the hash of the token it returns", () => {
    const { rawToken, tokenHash } = newConnectorToken();
    expect(tokenHash).toBe(hashConnectorToken(rawToken));
  });

  it("mints a different token each call", () => {
    expect(newConnectorToken().rawToken).not.toBe(newConnectorToken().rawToken);
  });
});

describe("hashConnectorToken", () => {
  it("is the SHA-256 hex digest of the raw token", () => {
    expect(hashConnectorToken("abc")).toBe(
      "ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad",
    );
    expect(hashConnectorToken("tok")).toBe(createHash("sha256").update("tok").digest("hex"));
  });
});
