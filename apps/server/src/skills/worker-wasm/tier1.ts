import type { Result } from "neverthrow";

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
   * Download `names` and their Pyodide dependencies into `packageCacheDir`
   * with integrity checks, through a child that has the network and no
   * permission flags, so later children find every file locally.
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
