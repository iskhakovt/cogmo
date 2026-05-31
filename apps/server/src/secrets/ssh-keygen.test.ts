import { ed25519 } from "@noble/curves/ed25519.js";
import { PrivateExport } from "micro-key-producer/ssh.js";
import { describe, expect, it } from "vitest";
import { generateSshKeyPair, type SshKeyPair } from "./ssh-keygen.js";

/**
 * Decode the OpenSSH-armored private-key block back into raw ed25519 bytes.
 *
 * `getKeys()` only hands us strings; pair-validity tests need the underlying
 * 32-byte secret seed and 32-byte public key. `PrivateExport` is the same
 * coder `micro-key-producer` uses internally to produce the armored text, so
 * decoding round-trips us back to the wire-format struct.
 */
function extractRawKeyBytes(pair: SshKeyPair): { secretKey: Uint8Array; publicKey: Uint8Array } {
  const decoded = PrivateExport.decode(pair.privateKey);
  const entry = decoded.keys[0];
  if (entry === undefined) {
    throw new Error("PrivateExport produced no key entries");
  }
  // `privKey` in the OpenSSH wire format is a 64-byte concatenation
  // [seed (32) || publicKey (32)]. ed25519 in @noble/curves takes the seed.
  const seed = entry.privKey.privKey.slice(0, 32);
  const publicKey = entry.pubKey.pubKey;
  return { secretKey: seed, publicKey };
}

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

  it("emits a private/public pair that signs and verifies a message", () => {
    const pair = generateSshKeyPair();
    const { secretKey, publicKey } = extractRawKeyBytes(pair);

    expect(secretKey).toHaveLength(32);
    expect(publicKey).toHaveLength(32);
    // The wire-format pubkey must match what ed25519 derives from the seed.
    // A drift here would mean the OpenSSH armor is internally inconsistent.
    expect(ed25519.getPublicKey(secretKey)).toEqual(publicKey);

    const message = new TextEncoder().encode("cogmo-bot signing test");
    const signature = ed25519.sign(message, secretKey);
    expect(ed25519.verify(signature, message, publicKey)).toBe(true);
  });

  it("rejects a signature when verified against a different keypair's public key", () => {
    const a = generateSshKeyPair();
    const b = generateSshKeyPair();
    const aBytes = extractRawKeyBytes(a);
    const bBytes = extractRawKeyBytes(b);

    const message = new TextEncoder().encode("cross-pair rejection");
    const signatureFromA = ed25519.sign(message, aBytes.secretKey);

    expect(ed25519.verify(signatureFromA, message, bBytes.publicKey)).toBe(false);
    // Sanity: the signature still verifies under its own keypair's public key,
    // so the rejection above is about pairing, not a malformed signature.
    expect(ed25519.verify(signatureFromA, message, aBytes.publicKey)).toBe(true);
  });
});
