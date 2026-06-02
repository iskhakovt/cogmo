import { describe, expect, it } from "vitest";
import { generateMasterKey } from "../../secrets/encryption.js";
import { deriveWebLoginToken, verifyWebLoginToken } from "./login-token.js";

describe("deriveWebLoginToken", () => {
  it("is deterministic for a fixed master key", () => {
    const key = generateMasterKey();
    expect(deriveWebLoginToken(key)).toBe(deriveWebLoginToken(key));
  });

  it("differs for different master keys", () => {
    expect(deriveWebLoginToken(generateMasterKey())).not.toBe(
      deriveWebLoginToken(generateMasterKey()),
    );
  });

  it("is base64url (URL/cookie-safe alphabet)", () => {
    expect(deriveWebLoginToken(generateMasterKey())).toMatch(/^[A-Za-z0-9_-]+$/);
  });
});

describe("verifyWebLoginToken", () => {
  const derived = deriveWebLoginToken(generateMasterKey());

  it("accepts the correct token", () => {
    expect(verifyWebLoginToken(derived, derived)).toBe(true);
  });

  it("rejects a wrong same-length token", () => {
    const flipped = `${derived.slice(0, -1)}${derived.at(-1) === "A" ? "B" : "A"}`;
    expect(verifyWebLoginToken(flipped, derived)).toBe(false);
  });

  it("rejects a wrong-length token without throwing", () => {
    expect(verifyWebLoginToken("short", derived)).toBe(false);
    expect(verifyWebLoginToken("", derived)).toBe(false);
  });
});
