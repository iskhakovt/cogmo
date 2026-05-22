import { randomUUID } from "node:crypto";
import { err, ok, type Result } from "neverthrow";
import { logger } from "../logger.js";
import {
  DEPS_CACHE_VOLUME_TARGET,
  type SandboxClient,
  type SandboxSession,
} from "../sandbox/index.js";

const log = logger.child({ component: "skills.deps-reaper" });

/** Default grace window before an unreachable venv is removed. */
const DEFAULT_GRACE_DAYS = 7;

/** Per-reap wall-clock cap. The script lists + deletes a small number of dirs. */
const REAP_TIMEOUT_MS = 60_000;

/**
 * Shell script run inside a transient sandbox session with `/skill-venvs`
 * mounted. Lists `<hash>/` directories whose mtime is older than the grace
 * window AND whose name isn't on the reachable list (read from stdin,
 * one hash per line). Deletes the unreachable ones. Prints each removed
 * dir on stdout for the host-side log.
 *
 * Args are positional: $1 = grace in days. Reachable hashes come via stdin
 * to avoid argv length limits when the skill library grows past ~100
 * lockfile-hash variants.
 *
 * Sentinel files (`.uv-cache`, `.tmp-*`) live alongside `<hash>/` dirs on
 * the same volume; the regex below restricts deletion to hex-only names
 * matching uv's sha256 layout so the cache subdir and any future
 * dot-prefixed marker can't be reaped.
 */
const REAP_SCRIPT = `set -eu
GRACE_DAYS="$1"
# Capture reachable hashes once; \`grep -vxFf\` against the temp file
# is a single-pass O(N) filter rather than N greps over the find output.
REACHABLE=$(mktemp)
trap 'rm -f "$REACHABLE"' EXIT
cat > "$REACHABLE"
cd "${DEPS_CACHE_VOLUME_TARGET}"
# -maxdepth/mindepth 1 -type d catches direct subdirs only -- the
# top-level mount point itself is excluded by mindepth.
# Regex restricts to lowercase-hex sha256 names so dot-prefixed sentinels
# and .tmp dirs (which the populate script's own sweeper owns) are
# protected.
# GNU find / grep semantics expected (cogmo-skills image is Debian-
# based via the runtime base image); -regex's Emacs syntax and
# -vxFf's "no patterns -> pass everything" behaviour are GNU-specific.
find . -maxdepth 1 -mindepth 1 -type d -regex '\\./[0-9a-f]\\{64\\}' -mtime "+\${GRACE_DAYS}" | sed 's|^\\./||' | grep -vxFf "$REACHABLE" | while read hash; do
  rm -rf "${DEPS_CACHE_VOLUME_TARGET}/$hash"
  echo "reaped:$hash"
done
`;

export interface ReapSkillVenvsOptions {
  sandbox: SandboxClient;
  /** Same image used by tier-2 workers; carries `sh`, `find`, `grep`. */
  image: string;
  depsCacheVolumeName: string;
  /** Lockfile hashes that must NOT be reaped (every live or disabled skill). */
  reachableHashes: ReadonlySet<string>;
  /** Days a directory must sit unreachable before reap. Defaults to 7. */
  graceDays?: number;
}

export interface ReapSkillVenvsResult {
  /** Hash directories actually deleted by this run. */
  reapedHashes: ReadonlyArray<string>;
}

export type ReapSkillVenvsError =
  | { kind: "transport_failed"; message: string }
  | { kind: "reap_failed"; message: string };

/**
 * Sweep unreachable per-lockfile-hash venvs under `/skill-venvs/`. Works
 * for any backend whose `SessionSpec.depsCacheVolume` mounts the same
 * volume the populator writes to -- so LocalDocker and Daytona share
 * one implementation.
 *
 * Safety invariants:
 *   - Only directories matching `^[0-9a-f]{64}$` (sha256 hex) are
 *     candidates. `.uv-cache/`, `.tmp.<workerId>/`, and any future
 *     dot-prefixed sentinel can't be reaped.
 *   - Reachable hashes pass through stdin (not argv) so the script
 *     scales past argv length limits when the library grows.
 *   - The mtime gate keeps the just-populated case safe: a venv
 *     created seconds ago by a register that's still in flight won't
 *     be considered unreachable until the grace window passes.
 */
export async function reapSkillVenvs(
  opts: ReapSkillVenvsOptions,
): Promise<Result<ReapSkillVenvsResult, ReapSkillVenvsError>> {
  const graceDays = opts.graceDays ?? DEFAULT_GRACE_DAYS;
  const taskId = `skill-venvs-reaper-${randomUUID()}`;
  const expiresAt = new Date(Date.now() + REAP_TIMEOUT_MS + 30_000);

  let session: SandboxSession;
  try {
    await opts.sandbox.ensureImagePresent(opts.image);
    session = await opts.sandbox.create({
      taskId,
      image: opts.image,
      resourceLimits: { cpus: 1, memory_bytes: 256 * 1024 * 1024, pids: 64 },
      expiresAt,
      depsCacheVolume: { volumeName: opts.depsCacheVolumeName },
    });
  } catch (e) {
    return err({
      kind: "transport_failed",
      message: e instanceof Error ? e.message : String(e),
    });
  }

  try {
    // execStreaming setup + handle.wait() can throw (timeout, transport
    // reject, stream construction failure). Without this catch the
    // rejection escapes the `Result` API contract.
    try {
      const handle = await session.execStreaming(
        ["sh", "-c", REAP_SCRIPT, "reap", String(graceDays)],
        { attachStdin: true, timeoutMs: REAP_TIMEOUT_MS },
      );
      if (!handle.stdin) {
        await handle.dispose().catch(() => {});
        return err({
          kind: "transport_failed",
          message: "execStreaming returned without stdin despite attachStdin=true",
        });
      }

      const stdoutChunks: string[] = [];
      const stderrChunks: string[] = [];
      let streamError: Error | undefined;
      const captureError = (e: Error): void => {
        if (!streamError) streamError = e;
      };
      handle.stdout.on("error", captureError);
      handle.stderr.on("error", captureError);
      handle.stdin.on("error", captureError);
      handle.stdout.setEncoding("utf-8");
      handle.stdout.on("data", (chunk: string) => stdoutChunks.push(chunk));
      handle.stderr.setEncoding("utf-8");
      handle.stderr.on("data", (chunk: string) => stderrChunks.push(chunk));

      // Trailing newline only when there's content; empty input writes
      // an empty file, which `grep -vxFf` reads as "no patterns -- pass
      // everything through" (the desired all-unreachable case).
      const reachableList = [...opts.reachableHashes];
      handle.stdin.end(reachableList.length > 0 ? `${reachableList.join("\n")}\n` : "");

      const { exitCode } = await handle.wait();
      if (streamError) {
        return err({ kind: "transport_failed", message: `stream error: ${streamError.message}` });
      }
      if (exitCode !== 0) {
        return err({
          kind: "reap_failed",
          message: `reap script exit ${exitCode}; stderr: ${stderrChunks.join("").trim()}`,
        });
      }

      const reapedHashes = stdoutChunks
        .join("")
        .split("\n")
        .map((l) => l.trim())
        .filter((l) => l.startsWith("reaped:"))
        .map((l) => l.slice("reaped:".length));

      log.info(
        { reapedCount: reapedHashes.length, reachableCount: opts.reachableHashes.size, graceDays },
        "skill-venvs reap completed",
      );
      return ok({ reapedHashes });
    } catch (e) {
      return err({
        kind: "transport_failed",
        message: e instanceof Error ? e.message : String(e),
      });
    }
  } finally {
    await opts.sandbox.delete(session).catch((e: unknown) => {
      log.warn({ err: e, taskId }, "reap session delete failed; reaper will retry on next tick");
    });
  }
}
