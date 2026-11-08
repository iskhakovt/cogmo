import type { Result } from "neverthrow";
import { match } from "ts-pattern";
import type { SkillInputs, SkillIo } from "../types.js";

/**
 * What a wasm child installs before it signals `ready`
 * (design/skills.md → Wasm-tier boundary, layer 4): the skill's
 * `requirements.lock`, plus Pyodide's pydantic when the body imports it. The
 * host resolves and fetches them; the child never reaches the network.
 */
export interface WasmPackages {
  /**
   * Pyodide-bundled packages the child loads from the package cache the host
   * filled and verified (`fillBuiltinCache`), by name.
   */
  builtins: readonly string[];
  /**
   * The read-only directory of hash-verified pure-Python wheels for the
   * lockfile, which the child installs from; null when the lockfile needs
   * none.
   */
  wheelDir: string | null;
}

/** A Pyodide-bundled package that does not load under the wasm boundary. */
export interface WasmProbeFailure {
  name: string;
  reason: string;
}

/**
 * Why a probe gave no clean answer: `rejected` names the packages that failed
 * to load, a verdict on them; `unavailable` means the probe itself did not
 * run to its end (the child crashed or timed out), which says nothing about
 * the packages.
 */
export type WasmProbeError =
  | { kind: "rejected"; failures: readonly WasmProbeFailure[] }
  | { kind: "unavailable"; message: string };

/**
 * The host-side use of a wasm child that runs no skill code: checking that
 * bundled native packages load under the boundary's flags (EM_JS builds JS
 * from strings at load, which `--disallow-code-generation-from-strings`
 * refuses).
 */
export interface WasmProbe {
  /**
   * Load and import each of `names` in a child under the boundary's flags,
   * from a `packageCacheDir` already filled and verified (`FillBuiltins`).
   * Errs `rejected` with every package that failed, or `unavailable` when the
   * probe could not run.
   */
  probeBuiltins(
    names: readonly string[],
    opts: { packageCacheDir: string; signal?: AbortSignal },
  ): Promise<Result<void, WasmProbeError>>;
}

/** A skill's `Input` and `Output` JSON Schemas, null for a model it does not define. */
export interface ImportedSchemas {
  inputs: SkillInputs | null;
  outputs: SkillIo | null;
}

/**
 * Why a schema import gave no schemas: `refused` is a verdict on the skill
 * (it did not import, or a model could not be described, or `Input` does not
 * describe an object); `unavailable` means the import did not run to its end
 * (the child could not start, crashed or timed out).
 */
export type SchemaImportError =
  | { kind: "refused"; message: string }
  | { kind: "unavailable"; message: string };

/**
 * Why register's wasm schema import gave no schemas: the skill's packages
 * could not be provided, which the import needs, or the import itself failed.
 */
export type SkillSchemaImportError =
  | { kind: "packages"; error: WasmPackagesError }
  | SchemaImportError;

/** The wasm tier's schema import at register (design/skills.md → Contracts). */
export interface WasmSchemaImporter {
  /**
   * Import `body` in a child under a task's boundary and memory cap, with
   * `packages` from local files and no network, and read its models' JSON
   * Schemas. The child outlives neither `timeoutMs` nor `signal`.
   */
  importSchemas(params: {
    body: string;
    packages: WasmPackages;
    packageCacheDir: string;
    memoryMb: number;
    timeoutMs: number;
    signal?: AbortSignal;
  }): Promise<Result<ImportedSchemas, SchemaImportError>>;
}

/**
 * Make `packageCacheDir` hold `names`, micropip and every bundled package they
 * depend on, each file hashing to the sha256 Pyodide's lockfile pins
 * (`fillBuiltinCache` over Pyodide's installed lockfile).
 */
export type FillBuiltins = (
  names: readonly string[],
  opts: { packageCacheDir: string; signal?: AbortSignal },
) => Promise<Result<void, WasmPackagesError>>;

/**
 * Why a lockfile's wasm packages could not be provided. The wheel kinds
 * name the package: `wheel_unavailable` and `hash_mismatch` are terminal for
 * the lockfile (PyPI does not serve a pure-Python wheel with a pinned hash),
 * while `network_failed`, `prefetch_failed`, `publish_failed` and
 * `bundled_unreadable` (Pyodide's own lockfile could not be read) may clear
 * on a retry. `builtin_integrity` names a built-in whose download from Pyodide's
 * CDN does not hash to the sha256 Pyodide's lockfile pins, or a cached file
 * that cannot be checked or deleted: a verdict on this deployment's cache or
 * its download, not on the skill's lockfile. Nothing unverified reaches the
 * cache; a cached file that fails its check is deleted and fetched again in
 * the same call.
 */
export type WasmPackagesError =
  | { kind: "wheel_unavailable"; spec: string; message: string }
  | { kind: "hash_mismatch"; spec: string; message: string }
  | { kind: "network_failed"; spec: string; message: string }
  | { kind: "prefetch_failed"; message: string }
  | { kind: "publish_failed"; message: string }
  | { kind: "bundled_unreadable"; message: string }
  | { kind: "builtin_integrity"; fileName: string; message: string };

/** One line naming why the lockfile's packages could not be made available. */
export function describeWasmPackagesError(error: WasmPackagesError): string {
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
export function summarizeWasmPackagesError(error: WasmPackagesError): string {
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
