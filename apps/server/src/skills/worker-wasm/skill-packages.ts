import { err, ok, type Result } from "neverthrow";
import { logger } from "../../logger.js";
import type { LockfileSnapshot } from "../deps.js";
import { PYDANTIC_MODULES, PYDANTIC_PACKAGE } from "../runtime-packages.js";
import type { WasmPackages, WasmPackagesError } from "./wasm.js";

const log = logger.child({ component: "skills.wasm" });

export interface SkillPackagesDeps {
  /** The lockfile's packages (`ensureWasmPackages`). */
  resolveLockfile(
    lockfile: LockfileSnapshot,
    signal: AbortSignal | undefined,
  ): Promise<Result<WasmPackages, WasmPackagesError>>;
  /** Fill the package cache with built-ins and their closure (`fillBuiltinCache`). */
  fillBuiltins(
    names: readonly string[],
    signal: AbortSignal | undefined,
  ): Promise<Result<void, WasmPackagesError>>;
  /** The body's import roots (`importRoots`), or why the parser could not load. */
  importRoots(body: string): PromiseLike<Result<ReadonlySet<string>, string>>;
}

/** What a wasm child's packages are resolved from. */
export interface SkillPackageSource {
  lockfile: LockfileSnapshot | undefined;
  body: string;
}

/**
 * Whether the body imports pydantic's runtime. A parser that cannot load
 * answers yes: loading a package the skill does not use costs the child a
 * moment, where missing one it does fails the run.
 */
async function importsPydantic(deps: SkillPackagesDeps, body: string): Promise<boolean> {
  return (await deps.importRoots(body)).match(
    (names) => [...PYDANTIC_MODULES].some((module) => names.has(module)),
    (error) => {
      log.warn({ error }, "import scan failed; the wasm child loads pydantic");
      return true;
    },
  );
}

/**
 * What a wasm child installs for a skill: its lockfile's packages, plus
 * Pyodide's pydantic when the body imports it, since skills share the
 * runtime's pydantic rather than declare it (design/skills.md → Contracts).
 */
export async function resolveSkillWasmPackages(
  deps: SkillPackagesDeps,
  args: SkillPackageSource & { signal?: AbortSignal },
): Promise<Result<WasmPackages, WasmPackagesError>> {
  const locked =
    args.lockfile === undefined
      ? ok<WasmPackages, WasmPackagesError>({ builtins: [], wheelDir: null })
      : await deps.resolveLockfile(args.lockfile, args.signal);
  if (locked.isErr()) return locked;
  const { builtins, wheelDir } = locked.value;
  if (builtins.includes(PYDANTIC_PACKAGE) || !(await importsPydantic(deps, args.body))) {
    return locked;
  }
  const filled = await deps.fillBuiltins([PYDANTIC_PACKAGE], args.signal);
  if (filled.isErr()) return err(filled.error);
  return ok({ builtins: [...builtins, PYDANTIC_PACKAGE], wheelDir });
}
