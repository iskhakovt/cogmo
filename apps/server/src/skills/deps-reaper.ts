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
# Reachability under the current runtime: a dir \`<hash>-py<X.Y>/\` is
# reachable iff \`<hash>\` is in the skills table AND \`<X.Y>\` matches
# THIS image's Python ABI. Stale ABI variants of a reachable hash
# (e.g. \`<hash>-py3.14/\` left behind after an image bump to py3.15)
# are unreachable from the current runtime and should sweep on the
# next tick once they age past the grace window. Same for legacy
# bare \`<hash>/\` dirs (from before the ABI suffix shipped) -- they
# look "reachable" by the bare hash but the supervisor will populate
# \`<hash>-py<X.Y>/\` on the next invoke, so the bare dir is dead
# weight. Solution: build the EXPECTED reachable dir-name set
# (\`<hash>-py<CURRENT_ABI>\` for every hash in REACHABLE) and compare
# candidate dirs against that set, not against the bare-hash set.
PY_ABI=$(python3 -c "import sys; print(f'py{sys.version_info.major}.{sys.version_info.minor}')")
REACHABLE=$(mktemp)
EXPECTED=$(mktemp)
trap 'rm -f "$REACHABLE" "$EXPECTED"' EXIT
cat > "$REACHABLE"
# Build the expected set: each reachable hash becomes <hash>-$PY_ABI.
# Empty REACHABLE -> empty EXPECTED -> grep -vxFf treats every
# candidate as unreachable (the desired all-stale-sweep behaviour).
while IFS= read -r h; do
  [ -n "$h" ] || continue
  echo "$h-$PY_ABI" >> "$EXPECTED"
done < "$REACHABLE"
cd "${DEPS_CACHE_VOLUME_TARGET}"
# -maxdepth/mindepth 1 -type d catches direct subdirs only -- the
# top-level mount point itself is excluded by mindepth.
# Regex matches lockfile-hash dirs in two shapes: bare \`<hash>/\` (legacy,
# pre-ABI-suffix) and \`<hash>-py<major>.<minor>/\` (current). Dot-prefixed
# sentinels (.uv-cache, .tmp.*) are excluded by the leading hex class.
# GNU find / grep semantics expected (cogmo-skills image is Debian-based);
# posix-extended regex + grep's empty-pattern-passes-everything behaviour
# are GNU-specific.
find . -maxdepth 1 -mindepth 1 -type d -regextype posix-extended -regex '\\./[0-9a-f]{64}(-py[0-9]+\\.[0-9]+)?' -mtime "+\${GRACE_DAYS}" | sed 's|^\\./||' | grep -vxFf "$EXPECTED" | while read dir; do
  rm -rf "${DEPS_CACHE_VOLUME_TARGET}/$dir"
  echo "reaped:$dir"
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
