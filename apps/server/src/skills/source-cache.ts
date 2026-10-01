import { Ajv, type ValidateFunction } from "ajv";
import { err, ok, type Result } from "neverthrow";
import { describeError } from "../util/describe-error.js";
import { type LockfileSnapshot, parseLockfilePackageSpecs, readLockfileAtSha } from "./deps.js";
import { readSkillSource, type SkillSource } from "./skill-source.js";
import type { SkillRow } from "./store/index.js";
import type { SkillInputs, SkillManifest } from "./types.js";

export interface SkillLockfileCacheValue {
  /** sha256, matches `skills.lockfile_hash`. */
  hash: string;
  /** Raw bytes — sysbox populator feeds to `uv pip sync` via stdin. */
  contents: string;
  /** Parsed `name==version` specs — WASM tier feeds to `micropip.install`. */
  specs: readonly string[];
}

export interface SkillSourceCacheEntry {
  readonly manifest: SkillManifest;
  readonly body: string;
  readonly inputsValidator: ValidateFunction;
  /** Present iff the manifest declares `outputs`. */
  readonly outputsValidator?: ValidateFunction;
  /**
   * Lockfile-derived data, populated atomically when the manifest declares
   * dependencies. All three fields go together; half-populated states are
   * unrepresentable. Absent when the manifest has no deps.
   */
  readonly lockfile?: SkillLockfileCacheValue;
}

/** Build the cohesive cache value from a lockfile snapshot. */
function buildLockfileCacheValue(snapshot: LockfileSnapshot): SkillLockfileCacheValue {
  return {
    hash: snapshot.hash,
    contents: snapshot.contents,
    specs: parseLockfilePackageSpecs(snapshot.contents),
  };
}

function cacheKey(name: string, gitSha: string): string {
  return `${name}@${gitSha}`;
}

/** One line per issue a validator reported on its last call: `<path> <message>`. */
export function schemaIssues(validator: ValidateFunction): string[] {
  return (validator.errors ?? []).map(
    (e) => `${e.instancePath || "<root>"} ${e.message ?? "invalid"}`,
  );
}

/**
 * Parsed manifests with their compiled JSON Schema validators, keyed by
 * `<name>@<sha>`. A new deploy invalidates by virtue of the new SHA being in
 * the key — no manual eviction needed. The deploy paths warm it with what
 * they just put live; a miss reads the source from the bare repo.
 */
export class SkillSourceCache {
  #ajv = new Ajv({ allErrors: true, strict: false });
  #entries = new Map<string, SkillSourceCacheEntry>();
  #repoPath: string | undefined;

  constructor(repoPath: string | undefined) {
    this.#repoPath = repoPath;
  }

  /**
   * Compile the manifest's `inputs` and (if declared) `outputs` JSON Schemas
   * *before* a deploy advances main or writes DB rows. Returns a flat list of
   * human-readable errors; an empty list means both compile.
   */
  prevalidate(manifest: SkillManifest): string[] {
    const inputs = this.#compileSchema(manifest.inputs).mapErr(
      (e) => `invalid_inputs_schema: ${e}`,
    );
    const outputs =
      manifest.outputs === undefined
        ? ok(undefined)
        : this.#compileSchema(manifest.outputs).mapErr((e) => `invalid_outputs_schema: ${e}`);
    return [inputs, outputs].flatMap((r) => (r.isErr() ? [r.error] : []));
  }

  /**
   * Cache a manifest that passed {@link prevalidate} with its compiled
   * validators, keyed by `(name, gitSha)`, so the next invoke or tool-list
   * read skips git. A schema failing to compile here is a bug.
   */
  put(
    gitSha: string,
    source: SkillSource,
    lockfile: LockfileSnapshot | null,
  ): SkillSourceCacheEntry {
    const { manifest, body } = source;
    const compiled = (schema: SkillInputs | Record<string, unknown>): ValidateFunction => {
      const validator = this.#compileSchema(schema);
      if (validator.isErr()) {
        throw new Error(`skill '${manifest.name}' @ ${gitSha}: schema invalid: ${validator.error}`);
      }
      return validator.value;
    };
    const entry: SkillSourceCacheEntry = {
      manifest,
      body,
      inputsValidator: compiled(manifest.inputs),
      ...(manifest.outputs !== undefined && { outputsValidator: compiled(manifest.outputs) }),
      ...(lockfile && { lockfile: buildLockfileCacheValue(lockfile) }),
    };
    this.#entries.set(cacheKey(manifest.name, gitSha), entry);
    return entry;
  }

  /**
   * The cached source for a skill row's `(name, gitSha)`, read from the bare
   * repo via `git show` on a miss.
   */
  async load(row: SkillRow): Promise<SkillSourceCacheEntry> {
    const cached = this.#entries.get(cacheKey(row.name, row.gitSha));
    if (cached) return cached;

    if (!this.#repoPath) {
      throw new Error(
        `no source for skill '${row.name}' — skillsRepoPath not configured and no test seed cached`,
      );
    }

    // A deployed sha passed these reads at register, so a failure here is
    // the repo and the DB out of sync — corruption, not an outcome to handle.
    const source = await readSkillSource(this.#repoPath, row.gitSha);
    if (source.isErr()) {
      throw new Error(
        `no source for skill '${row.name}' at ${row.gitSha} (${source.error.kind}) — repo and DB are out of sync`,
      );
    }
    let lockfile: LockfileSnapshot | null = null;
    if (row.lockfileHash !== null) {
      // Lockfile presence is invariant with `row.lockfileHash != null` —
      // register persists the hash atomically with the gitSha, so a row
      // with a hash always has a committed lockfile. A missing/empty
      // read here means the repo + DB drifted (manual git tampering,
      // partial restore, ...) — surface it loudly.
      const snapshot = await readLockfileAtSha(this.#repoPath, row.gitSha);
      if (snapshot.isErr()) {
        throw new Error(
          `lockfile for skill '${row.name}' at ${row.gitSha} is ${snapshot.error.kind} — repo and DB are out of sync (skills.lockfile_hash=${row.lockfileHash})`,
        );
      }
      lockfile = snapshot.value;
    }
    return this.put(row.gitSha, source.value, lockfile);
  }

  /**
   * Compile one of a manifest's JSON Schemas, or err with why it can't
   * validate: ajv rejects it, or it is `$async`, whose validator returns a
   * promise that a truthiness check would read as valid.
   */
  #compileSchema(schema: SkillInputs | Record<string, unknown>): Result<ValidateFunction, string> {
    let validator: ValidateFunction;
    try {
      validator = this.#ajv.compile(schema);
    } catch (e) {
      return err(describeError(e));
    }
    return "$async" in validator && validator.$async === true
      ? err("$async schemas are not supported")
      : ok(validator);
  }
}
