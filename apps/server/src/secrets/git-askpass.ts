/**
 * One-shot `GIT_ASKPASS` helper for orchestrator-side git invocations
 * (e.g. cloning a repo registered via `/repo add` against a private
 * remote that requires the bot's PAT).
 *
 * Per-task askpass for in-container git inside the sandbox lives separately
 * (slice 4.0d, `src/sandbox/askpass.ts`). This module is for **host-side**
 * one-shot use: caller invokes `withGitAskpass(pat, fn)`, fn runs with the
 * PAT exposed only via `GIT_ASKPASS`, and the helper directory is wiped
 * unconditionally on return — even if `fn` throws.
 *
 * Design notes:
 * - Helper script writes the PAT to stdout and exits. Git invokes it for
 *   both Username and Password prompts; `GIT_TERMINAL_PROMPT=0` ensures
 *   git never falls back to interactive auth and hangs.
 * - Tempdir lives under `os.tmpdir()` (typically `/tmp`) with mode 0700;
 *   the helper file gets 0700, the secret file 0600.
 * - PAT is written to a sibling file (not embedded in the script), so the
 *   shell script body itself is not sensitive — it just `cat`s the file.
 * - We don't write the PAT to env vars passed to the child, only to a
 *   file the helper reads. `ps -e -ww` doesn't see the PAT this way.
 */

import { type SpawnOptionsWithoutStdio, spawn } from "node:child_process";
import { chmodSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

export interface GitEnv {
  /** Absolute path to the helper script — set as `GIT_ASKPASS`. */
  GIT_ASKPASS: string;
  /** Disable interactive terminal fallback so misconfiguration fails fast. */
  GIT_TERMINAL_PROMPT: "0";
}

/**
 * Run `fn` with a freshly minted askpass helper. Helper directory is
 * deleted on return regardless of outcome; callers don't need to clean up.
 */
export async function withGitAskpass<T>(pat: string, fn: (env: GitEnv) => Promise<T>): Promise<T> {
  const dir = mkdtempSync(join(tmpdir(), "cogmo-askpass-"));
  try {
    chmodSync(dir, 0o700);
    const secretPath = join(dir, "pat");
    const helperPath = join(dir, "askpass.sh");
    writeFileSync(secretPath, pat, { mode: 0o600 });
    // `cat` via PATH, not `/bin/cat` — this helper runs on the HOST, and
    // non-FHS hosts (NixOS) have no /bin/cat. git invokes the helper with
    // the trusted host process env, so PATH resolution is safe here. The
    // in-container helper (src/sandbox/askpass.ts) keeps the absolute path:
    // task images are FHS and their PATH is not ours to trust.
    writeFileSync(helperPath, `#!/bin/sh\nexec cat ${shellQuote(secretPath)}\n`, {
      mode: 0o700,
    });
    return await fn({ GIT_ASKPASS: helperPath, GIT_TERMINAL_PROMPT: "0" });
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

/**
 * Spawn `git` with the supplied args + (optional) askpass env and resolve
 * with the combined stdout/stderr text. Rejects with a descriptive error
 * on non-zero exit so callers don't have to thread streams themselves.
 *
 * `env` is optional: network-touching ops (fetch/push) pass the askpass
 * helper to gate credentials and disable terminal prompts; local-only ops
 * (rev-parse, config reads) omit it so they don't have to stand up an
 * askpass helper they'd never invoke. When omitted, git inherits the
 * process's environment unchanged.
 */
export function runGit(
  args: ReadonlyArray<string>,
  env?: GitEnv,
  opts?: SpawnOptionsWithoutStdio,
): Promise<{ stdout: string; stderr: string }> {
  return new Promise((resolve, reject) => {
    const child = spawn("git", [...args], {
      ...opts,
      env: {
        ...process.env,
        ...opts?.env,
        ...(env && {
          GIT_ASKPASS: env.GIT_ASKPASS,
          GIT_TERMINAL_PROMPT: env.GIT_TERMINAL_PROMPT,
        }),
      },
      stdio: ["ignore", "pipe", "pipe"],
    });

    const stdoutChunks: Buffer[] = [];
    const stderrChunks: Buffer[] = [];
    child.stdout.on("data", (chunk: Buffer) => stdoutChunks.push(chunk));
    child.stderr.on("data", (chunk: Buffer) => stderrChunks.push(chunk));

    child.on("error", reject);
    child.on("close", (code) => {
      const stdout = Buffer.concat(stdoutChunks).toString("utf8");
      const stderr = Buffer.concat(stderrChunks).toString("utf8");
      if (code === 0) {
        resolve({ stdout, stderr });
        return;
      }
      const err = new Error(
        `git ${args.join(" ")} exited with code ${code ?? "(signal)"}: ${stderr.trim() || stdout.trim()}`,
      );
      reject(err);
    });
  });
}

/** Shell-quote a path for embedding inside a `/bin/sh` script. */
function shellQuote(s: string): string {
  return `'${s.replace(/'/g, `'\\''`)}'`;
}
