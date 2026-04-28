import { describe, expect, it } from "vitest";
import { generateSshKeyPair } from "./ssh-keygen.js";

describe("generateSshKeyPair", () => {
  it("returns a complete OpenSSH-formatted keypair", () => {
    const pair = generateSshKeyPair();
    expect(pair.privateKey.startsWith("-----BEGIN OPENSSH PRIVATE KEY-----")).toBe(true);
    expect(pair.privateKey.trimEnd().endsWith("-----END OPENSSH PRIVATE KEY-----")).toBe(true);
    expect(pair.publicKey.startsWith("ssh-ed25519 ")).toBe(true);
    expect(pair.fingerprint.startsWith("SHA256:")).toBe(true);
  });

  it("renders the supplied comment on the public-key line", () => {
    const pair = generateSshKeyPair("cogmo-bot@host");
    expect(pair.publicKey.endsWith(" cogmo-bot@host")).toBe(true);
  });

  it("defaults the comment to cogmo-bot when none is supplied", () => {
    const pair = generateSshKeyPair();
    expect(pair.publicKey.endsWith(" cogmo-bot")).toBe(true);
  });

  it("produces a fresh keypair on each call (random seed)", () => {
    const a = generateSshKeyPair();
    const b = generateSshKeyPair();
    expect(a.publicKey).not.toBe(b.publicKey);
    expect(a.privateKey).not.toBe(b.privateKey);
    expect(a.fingerprint).not.toBe(b.fingerprint);
  });
});
