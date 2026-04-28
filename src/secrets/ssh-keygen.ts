/**
 * Ed25519 SSH keypair generation for the GitHub identity bundle.
 *
 * Wraps `micro-key-producer/ssh.js` (Paul Miller, MIT, same noble family
 * as `@noble/ciphers` + `@noble/hashes`) so callers get OpenSSH-formatted
 * `privateKey` (PEM), `publicKey` (`ssh-ed25519 ... comment` line), and
 * SHA-256 `fingerprint` strings ready to round-trip through git's
 * `gpg.format=ssh` + `user.signingkey <path>` config.
 */

import { randomBytes } from "@noble/ciphers/utils.js";
import { getKeys } from "micro-key-producer/ssh.js";

export interface SshKeyPair {
  /** OpenSSH-armored private key, ready to write to disk for `user.signingkey`. */
  privateKey: string;
  /** Single-line `ssh-ed25519 AAAA... <comment>` form, ready to paste into github.com/settings/ssh/new. */
  publicKey: string;
  /** `SHA256:...` fingerprint matching `ssh-keygen -lf <pub>`. */
  fingerprint: string;
}

/**
 * Generate a fresh Ed25519 keypair with a 32-byte random seed.
 *
 * `comment` is rendered as the trailing comment field on the public-key
 * line and embedded inside the private-key block. Default `cogmo-bot`
 * keeps existing identities recognisable on github.com without leaking
 * the host the wizard ran on.
 */
export function generateSshKeyPair(comment = "cogmo-bot"): SshKeyPair {
  const seed = randomBytes(32);
  const keys = getKeys(seed, comment);
  return {
    privateKey: keys.privateKey,
    publicKey: keys.publicKey,
    fingerprint: keys.fingerprint,
  };
}
