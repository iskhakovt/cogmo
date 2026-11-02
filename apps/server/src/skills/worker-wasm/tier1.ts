import type { Result } from "neverthrow";
import { match } from "ts-pattern";

/**
 * What a tier-1 child installs before it signals `ready`
 * (design/skills.md → Tier-1 boundary, layer 4). Both come from the skill's
 * `requirements.lock`; the host resolves and fetches them, the child never
 * reaches the network.
 */
export interface Tier1Packages {
  /**
   * Pyodide-bundled packages the child loads from the package cache the host
   * filled (`prefetchBuiltins`), by name.
   */
  builtins: readonly string[];
  /**
   * The read-only directory of hash-verified pure-Python wheels for the
   * lockfile, which the child installs from; null when the lockfile needs
   * none.
   */
  wheelDir: string | null;
}

/** A Pyodide-bundled package that does not load under the tier-1 boundary. */
export interface Tier1ProbeFailure {
  name: string;
  reason: string;
}

/**
 * Why a probe gave no clean answer: `rejected` names the packages that failed
 * to load, a verdict on them; `unavailable` means the probe itself did not
 * run to its end (the child crashed or timed out), which says nothing about
 * the packages.
 */
export type Tier1ProbeError =
  | { kind: "rejected"; failures: readonly Tier1ProbeFailure[] }
  | { kind: "unavailable"; message: string };

/**
 * The two host-side uses of a tier-1 child that run no skill code: filling the
 * package cache from the network, and checking that bundled native packages
 * load under the boundary's flags (EM_JS builds JS from strings at load, which
 * `--disallow-code-generation-from-strings` refuses).
 */
export interface Tier1Prefetcher {
  /**
   * Download `names` and their Pyodide dependencies into `packageCacheDir`,
   * through a child that has the network and no permission flags, so later
   * children find every file locally. Pyodide checks no integrity under
   * Node; `fillBuiltinCache` hands it a staging directory and hashes what it
   * wrote there before anything reaches the cache.
   */
  prefetchBuiltins(
    names: readonly string[],
    opts: { packageCacheDir: string; signal?: AbortSignal },
  ): Promise<Result<void, string>>;
  /**
   * Load and import each of `names` in a child under the boundary's flags,
   * from an already filled `packageCacheDir`. Errs `rejected` with every
   * package that failed, or `unavailable` when the probe could not run.
   */
  probeBuiltins(
    names: readonly string[],
    opts: { packageCacheDir: string; signal?: AbortSignal },
  ): Promise<Result<void, Tier1ProbeError>>;
}

/**
 * Why a lockfile's tier-1 packages could not be provided. The wheel kinds
 * name the package: `wheel_unavailable` and `hash_mismatch` are terminal for
 * the lockfile (PyPI does not serve a pure-Python wheel with a pinned hash),
 * while `network_failed`, `prefetch_failed`, `publish_failed` and
 * `bundled_unreadable` (Pyodide's own lockfile could not be read) may clear
 * on a retry. `builtin_integrity` names a package-cache file that does not
 * hash to the sha256 Pyodide's lockfile pins after a prefetch, or that cannot
 * be checked: a verdict on this deployment's cache or its download, not on the
 * skill's lockfile. The mismatching file is deleted, so a retry fetches it again.
 */
export type Tier1PackagesError =
  | { kind: "wheel_unavailable"; spec: string; message: string }
  | { kind: "hash_mismatch"; spec: string; message: string }
  | { kind: "network_failed"; spec: string; message: string }
  | { kind: "prefetch_failed"; message: string }
  | { kind: "publish_failed"; message: string }
  | { kind: "bundled_unreadable"; message: string }
  | { kind: "builtin_integrity"; fileName: string; message: string };

/** One line naming why the lockfile's packages could not be made available. */
export function describeTier1PackagesError(error: Tier1PackagesError): string {
  return match(error)
    .with(
      { kind: "wheel_unavailable" },
      { kind: "hash_mismatch" },
      { kind: "network_failed" },
      (e) => `${e.kind}: ${e.spec}: ${e.message}`,
    )
    .with(
      { kind: "prefetch_failed" },
      { kind: "publish_failed" },
      { kind: "bundled_unreadable" },
      (e) => `${e.kind}: ${e.message}`,
    )
    .with({ kind: "builtin_integrity" }, (e) => `${e.kind}: ${e.fileName}: ${e.message}`)
    .exhaustive();
}

/**
 * The error's kind and, for a wheel, its package spec. Text the model reads:
 * the messages carry host paths and upstream detail, which only logs and
 * operator output show.
 */
export function summarizeTier1PackagesError(error: Tier1PackagesError): string {
  return match(error)
    .with(
      { kind: "wheel_unavailable" },
      { kind: "hash_mismatch" },
      { kind: "network_failed" },
      (e) => `${e.kind} for ${e.spec}`,
    )
    .with(
      { kind: "prefetch_failed" },
      { kind: "publish_failed" },
      { kind: "bundled_unreadable" },
      { kind: "builtin_integrity" },
      (e) => e.kind,
    )
    .exhaustive();
}
