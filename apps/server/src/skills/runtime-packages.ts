import { err, ok, type Result } from "neverthrow";
import { parseLockfileEntries } from "./deps.js";
import { normalizePackageName } from "./pyodide-compat.js";

/**
 * The packages both skill runtimes provide, at the one version each tier
 * runs: the skills image's runtime venv pins the version Pyodide builds in
 * (design/skills.md → Contracts). `pydantic-core` is native, so a skill can
 * run only the build its tier carries. A unit test checks the pins against
 * Pyodide's `pyodide-lock.json`; the generated
 * `images/skills/contract/runtime-packages.json` carries them and
 * `RUNTIME_FLOORS` to the image's pytest, which checks them against the
 * installed pydantic.
 */
export const RUNTIME_PACKAGES = { pydantic: "2.12.5", "pydantic-core": "2.41.5" } as const;

/**
 * pydantic 2.12.5's other requirements, as the lowest version of each it
 * accepts. A skill's lockfile may pin them, since a skill's venv shadows
 * the runtime's, but not below these.
 */
export const RUNTIME_FLOORS = {
  "annotated-types": "0.6.0",
  "typing-extensions": "4.14.1",
  "typing-inspection": "0.4.2",
} as const;

/**
 * The modules a skill imports pydantic's runtime by. On the wasm tier any of
 * them loads Pyodide's `pydantic` package, which brings `pydantic-core`.
 */
export const PYDANTIC_MODULES: ReadonlySet<string> = new Set(["pydantic", "pydantic_core"]);

/** The Pyodide package a wasm child loads for `PYDANTIC_MODULES`. */
export const PYDANTIC_PACKAGE = "pydantic";

/** A release segment's numbers, `4.14.1rc1` → `[4, 14, 1]`. */
function release(version: string): number[] {
  return (/^\d+(\.\d+)*/.exec(version)?.[0] ?? "0").split(".").map(Number);
}

/** A pre-release or development release, which PEP 440 orders below its release. */
function isPreRelease(version: string): boolean {
  return /^\d+(\.\d+)*(a|b|rc|\.?dev)/i.test(version);
}

function below(version: string, floor: string): boolean {
  const [a, b] = [release(version), release(floor)];
  for (let i = 0; i < Math.max(a.length, b.length); i++) {
    const [x, y] = [a[i] ?? 0, b[i] ?? 0];
    if (x !== y) return x < y;
  }
  return isPreRelease(version) && !isPreRelease(floor);
}

/**
 * Refuse a lockfile that pins a runtime package at another version, or one
 * of pydantic's requirements below its floor. The skill's copy would shadow
 * the runtime's (the skill venv is first on the container tier's
 * `sys.path`, and wasm wheels install before built-ins), so the tiers would
 * run different pydantic, or pydantic would not import. Errs with the
 * author-facing line.
 */
export function checkRuntimePins(lockfileContents: string): Result<void, string> {
  const pins = new Map<string, string>(Object.entries(RUNTIME_PACKAGES));
  const floors = new Map<string, string>(Object.entries(RUNTIME_FLOORS));
  const conflicts = parseLockfileEntries(lockfileContents).flatMap((entry) => {
    const name = normalizePackageName(entry.name);
    const pin = pins.get(name);
    const floor = floors.get(name);
    if (pin !== undefined && pin !== entry.version) {
      return [`${name}==${entry.version} (the runtime's is ${pin})`];
    }
    if (floor !== undefined && below(entry.version, floor)) {
      return [`${name}==${entry.version} (pydantic needs >=${floor})`];
    }
    return [];
  });
  if (conflicts.length === 0) return ok();
  return err(
    `runtime_package_conflict: requirements.lock pins ${conflicts.join(", ")}. Skills share the runtime's pydantic; declare pydantic==${RUNTIME_PACKAGES.pydantic} in dependencies so the compile resolves around it, and recompile.`,
  );
}
