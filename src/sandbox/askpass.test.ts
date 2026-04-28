import { existsSync, mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type { GitHubIdentity } from "../secrets/github.js";
import { CONTAINER_ASKPASS_DIR, cleanupAskpass, provisionAskpass } from "./askpass.js";

const VALID_IDENTITY: GitHubIdentity = {
  pat: "ghp_dummy_xxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxx",
  sshPrivateKey: "-----BEGIN OPENSSH PRIVATE KEY-----\nABC\n-----END OPENSSH PRIVATE KEY-----",
  sshPublicKey: "ssh-ed25519 AAAA cogmo-bot",
  login: "cogmo-bot",
  id: "1",
};

let baseDir: string;

beforeEach(() => {
  baseDir = mkdtempSync(join(tmpdir(), "cogmo-askpass-test-"));
});

afterEach(() => {
  rmSync(baseDir, { recursive: true, force: true });
});

describe("provisionAskpass", () => {
  it("creates the per-task directory under the base dir", () => {
    const m = provisionAskpass({ baseDir, rootTaskId: "task-1", identity: VALID_IDENTITY });
    expect(m.hostDir).toBe(join(baseDir, "task-1"));
    expect(existsSync(m.hostDir)).toBe(true);
  });

  it("writes pat / helper / signing-key / signing-key.pub world-readable inside a 0700 parent", () => {
    const m = provisionAskpass({ baseDir, rootTaskId: "t", identity: VALID_IDENTITY });
    const dirMode = statSync(m.hostDir).mode & 0o777;
    const patMode = statSync(join(m.hostDir, "pat")).mode & 0o777;
    const helperMode = statSync(join(m.hostDir, "helper")).mode & 0o777;
    const keyMode = statSync(join(m.hostDir, "signing-key")).mode & 0o777;
    const pubMode = statSync(join(m.hostDir, "signing-key.pub")).mode & 0o777;
    // Parent locked so other host users can't traverse; files world-readable
    // so userns-remapped container uids can still read them via the bind mount.
    expect(dirMode).toBe(0o700);
    expect(patMode).toBe(0o644);
    expect(helperMode).toBe(0o755);
    // Signing key stays 0o600 — ssh-keygen -Y sign refuses to load a key
    // with broader permissions, regardless of userns mapping.
    expect(keyMode).toBe(0o600);
    expect(pubMode).toBe(0o644);
  });

  it("writes the PAT verbatim and a helper that exec-cats the in-container PAT path", () => {
    const m = provisionAskpass({ baseDir, rootTaskId: "t", identity: VALID_IDENTITY });
    expect(readFileSync(join(m.hostDir, "pat"), "utf8")).toBe(VALID_IDENTITY.pat);
    const helper = readFileSync(join(m.hostDir, "helper"), "utf8");
    expect(helper).toContain("#!/bin/sh");
    expect(helper).toContain(`'${CONTAINER_ASKPASS_DIR}/pat'`);
  });

  it("normalises trailing newlines on the SSH private key", () => {
    const noNewline: GitHubIdentity = {
      ...VALID_IDENTITY,
      sshPrivateKey: "-----BEGIN OPENSSH PRIVATE KEY-----\nABC\n-----END OPENSSH PRIVATE KEY-----",
    };
    const m = provisionAskpass({ baseDir, rootTaskId: "t", identity: noNewline });
    const written = readFileSync(join(m.hostDir, "signing-key"), "utf8");
    expect(written.endsWith("\n")).toBe(true);
    expect(written.endsWith("\n\n")).toBe(false);
  });

  it("returns env vars pointing at in-container paths (not host paths)", () => {
    const m = provisionAskpass({ baseDir, rootTaskId: "t", identity: VALID_IDENTITY });
    expect(m.env).toEqual({
      GIT_ASKPASS: `${CONTAINER_ASKPASS_DIR}/helper`,
      GIT_TERMINAL_PROMPT: "0",
    });
    expect(m.signingKeyPath).toBe(`${CONTAINER_ASKPASS_DIR}/signing-key`);
    expect(m.helperPath).toBe(`${CONTAINER_ASKPASS_DIR}/helper`);
    expect(m.containerDir).toBe(CONTAINER_ASKPASS_DIR);
  });

  it("regenerates contents on re-provision (idempotent retry path)", () => {
    const m = provisionAskpass({ baseDir, rootTaskId: "t", identity: VALID_IDENTITY });
    // Simulate stale content from a prior crash.
    writeFileSync(join(m.hostDir, "pat"), "STALE");
    writeFileSync(join(m.hostDir, "extra"), "leftover");

    provisionAskpass({ baseDir, rootTaskId: "t", identity: VALID_IDENTITY });
    expect(readFileSync(join(m.hostDir, "pat"), "utf8")).toBe(VALID_IDENTITY.pat);
    expect(existsSync(join(m.hostDir, "extra"))).toBe(false);
  });
});

describe("cleanupAskpass", () => {
  it("removes the per-task directory recursively", () => {
    const m = provisionAskpass({ baseDir, rootTaskId: "t", identity: VALID_IDENTITY });
    expect(existsSync(m.hostDir)).toBe(true);
    cleanupAskpass({ baseDir, rootTaskId: "t" });
    expect(existsSync(m.hostDir)).toBe(false);
  });

  it("is idempotent — removing an already-clean task is a no-op", () => {
    cleanupAskpass({ baseDir, rootTaskId: "never-provisioned" });
    cleanupAskpass({ baseDir, rootTaskId: "never-provisioned" });
  });

  it("doesn't remove sibling task directories", () => {
    provisionAskpass({ baseDir, rootTaskId: "alpha", identity: VALID_IDENTITY });
    const beta = provisionAskpass({ baseDir, rootTaskId: "beta", identity: VALID_IDENTITY });
    cleanupAskpass({ baseDir, rootTaskId: "alpha" });
    expect(existsSync(beta.hostDir)).toBe(true);
  });
});
