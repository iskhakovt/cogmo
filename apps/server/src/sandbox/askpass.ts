/**
 * Per-task `GIT_ASKPASS` + SSH signing-key material for in-container git.
 *
 * Layout (host side):
 *   ${baseDir}/<rootTaskId>/
 *     helper       0700 — `#!/bin/sh; exec cat ${baseDir}/.../pat`
 *     pat          0600 — the bot account's fine-grained PAT
 *     signing-key  0600 — OpenSSH-armored Ed25519 signing key
 *     signing-key.pub  0644 — `ssh-ed25519 ... <comment>`
 *
 * Each file's host path is bind-mounted read-only into the container at
 * `/tmp/cogmo-askpass/`, so the in-container view is:
 *   /tmp/cogmo-askpass/helper
 *   /tmp/cogmo-askpass/pat
 *   /tmp/cogmo-askpass/signing-key
 *   /tmp/cogmo-askpass/signing-key.pub
 *
 * Env vars threaded into `exec`:
 *   GIT_ASKPASS=/tmp/cogmo-askpass/helper
 *   GIT_TERMINAL_PROMPT=0
 *
 * Commit signing is configured per-invocation by the commit-and-push step
 * (slice 4.0f) via `git -c gpg.format=ssh -c user.signingkey=/tmp/cogmo-askpass/signing-key`,
 * not via env — git's signing path doesn't read env, only config.
 *
 * Lifecycle: `provisionAskpass` writes the directory, `cleanupAskpass`
 * removes it. The sandbox supervisor wires cleanup into `stopTask`'s
 * `try/finally` so partial provisioning is recovered even when the
 * cascade kill panics.
 */

import { mkdirSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { logger } from "../logger.js";
import type { GitHubIdentity } from "../secrets/github.js";

const log = logger.child({ component: "sandbox.askpass" });

/** Mount target inside the container. `/tmp` because the Daytona toolbox
 * uploads as the sandbox's non-root user and can't `mkdir /<anything>`. */
export const CONTAINER_ASKPASS_DIR = "/tmp/cogmo-askpass";

export interface AskpassMaterials {
  /** Host directory holding the helper + secret files. Bind-mount source. */
  hostDir: string;
  /** Mount target inside the container — always `/tmp/cogmo-askpass`. */
  containerDir: string;
  /** Env vars to pass via `exec`'s `opts.env` when running git. */
  env: Readonly<Record<string, string>>;
  /** In-container path to the signing key file — passed to `git -c user.signingkey=<path>`. */
  signingKeyPath: string;
  /** In-container path to the helper script — same value as `env.GIT_ASKPASS`. */
  helperPath: string;
  /** In-container path to the PAT plaintext — useful for diagnostics, never logged. */
  patPath: string;
}

/**
 * Write the per-task askpass material. Idempotent on re-run: an existing
 * directory at the target path is removed first so the contents are always
 * fresh. The caller (sandbox supervisor) is responsible for adding
 * `${hostDir}:${CONTAINER_ASKPASS_DIR}:ro` to the container's bind mounts.
 */
export function provisionAskpass(opts: {
  baseDir: string;
  rootTaskId: string;
  identity: GitHubIdentity;
}): AskpassMaterials {
  const hostDir = join(opts.baseDir, opts.rootTaskId);

  // Idempotent re-provision — orchestrator retries that re-enter
  // `create-container` step shouldn't fail on an existing dir.
  rmSync(hostDir, { recursive: true, force: true });

  mkdirSync(hostDir, { recursive: true, mode: 0o700 });

  const patPath = join(hostDir, "pat");
  const helperPath = join(hostDir, "helper");
  const signingKeyPath = join(hostDir, "signing-key");
  const signingKeyPubPath = join(hostDir, "signing-key.pub");

  // Modes are calibrated against two competing constraints:
  //
  // - The container needs to read these files via the bind mount. Under
  //   runtimes that map the container's uid to a host subordinate uid
  //   (plain runc with userns, idmapped mounts without shift), 0o600 files
  //   owned by the host's cogmo uid are unreadable inside the container.
  //   World-readable file modes work everywhere; confidentiality on the
  //   host comes from the parent dir's 0o700 (only the cogmo runtime user
  //   can traverse).
  //
  // - `ssh-keygen -Y sign` (the SSH commit signing path) STRICTLY requires
  //   the private key file to be 0o600 — it refuses to load a key with
  //   broader permissions and aborts the signing operation. This overrides
  //   the userns concern: signing always needs 0o600 on the key, so the
  //   slice-1 contract that the container CLI user matches the host cogmo
  //   uid (vscode = 1000) is what makes this work in practice.
  //
  // Helper script + PAT + public key are world-readable (cat-only access,
  // no embedded secrets in the helper). Signing key is 0o600 by necessity.
  writeFileSync(patPath, opts.identity.pat, { mode: 0o644 });
  writeFileSync(signingKeyPath, normaliseTrailingNewline(opts.identity.sshPrivateKey), {
    mode: 0o600,
  });
  writeFileSync(signingKeyPubPath, normaliseTrailingNewline(opts.identity.sshPublicKey), {
    mode: 0o644,
  });

  // The helper writes the PAT to stdout. Git invokes the helper with one
  // argument ("Username for ..." / "Password for ...") for both prompts;
  // we ignore the prompt text and always print the PAT — Git accepts the
  // same value for both Username and Password fields when paired with a
  // fine-grained PAT, and wrong-username retries don't happen on the
  // happy path.
  // `cat` via PATH, not an absolute path: PATH resolution costs nothing
  // security-wise (anything that can poison the container's PATH already
  // executes arbitrary code in the container), and it keeps the helper
  // runnable on non-FHS hosts when tests exercise it outside a container.
  const containerPatPath = `${CONTAINER_ASKPASS_DIR}/pat`;
  const helperBody = `#!/bin/sh\nexec cat ${shellQuote(containerPatPath)}\n`;
  writeFileSync(helperPath, helperBody, { mode: 0o755 });

  const env: Readonly<Record<string, string>> = Object.freeze({
    GIT_ASKPASS: `${CONTAINER_ASKPASS_DIR}/helper`,
    GIT_TERMINAL_PROMPT: "0",
  });

  return {
    hostDir,
    containerDir: CONTAINER_ASKPASS_DIR,
    env,
    signingKeyPath: `${CONTAINER_ASKPASS_DIR}/signing-key`,
    helperPath: `${CONTAINER_ASKPASS_DIR}/helper`,
    patPath: containerPatPath,
  };
}

/**
 * Remove the per-task askpass directory. Idempotent — a missing directory
 * (no provisioning happened, or already cleaned up) is not an error.
 *
 * Failure to clean up is logged but never thrown: the cascade-kill in
 * `stopTask` runs first, and we'd rather leave a stale dir behind than
 * mask a real container teardown error with a filesystem race.
 */
export function cleanupAskpass(opts: { baseDir: string; rootTaskId: string }): void {
  const hostDir = join(opts.baseDir, opts.rootTaskId);
  try {
    rmSync(hostDir, { recursive: true, force: true });
  } catch (err) {
    log.warn({ err, hostDir }, "askpass cleanup failed");
  }
}

function shellQuote(s: string): string {
  return `'${s.replace(/'/g, `'\\''`)}'`;
}

/**
 * Ensure the value ends with exactly one newline — git and openssh both
 * fail or warn on private-key files lacking a trailing newline.
 */
function normaliseTrailingNewline(s: string): string {
  return s.endsWith("\n") ? s : `${s}\n`;
}
