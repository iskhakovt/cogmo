import { err, ok } from "neverthrow";
import { describe, expect, it, vi } from "vitest";
import { resolveSkillWasmPackages, type SkillPackagesDeps } from "./skill-packages.js";

const LOCKFILE = { hash: "a".repeat(64), contents: "httpx==0.28.1\n" };

const LOCKED = { builtins: ["httpx"], wheelDir: "/w" };

function fakes(roots: readonly string[], locked: { builtins: string[]; wheelDir: string }) {
  return {
    resolveLockfile: vi.fn<SkillPackagesDeps["resolveLockfile"]>(async () => ok(locked)),
    fillBuiltins: vi.fn<SkillPackagesDeps["fillBuiltins"]>(async () => ok()),
    importRoots: vi.fn<SkillPackagesDeps["importRoots"]>(async () => ok(new Set(roots))),
  };
}

describe("resolveSkillWasmPackages", () => {
  it("installs nothing for a skill with no lockfile and no pydantic import", async () => {
    const deps = fakes(["json"], LOCKED);
    const resolved = await resolveSkillWasmPackages(deps, { lockfile: undefined, body: "" });
    expect(resolved._unsafeUnwrap()).toEqual({ builtins: [], wheelDir: null });
    expect(deps.resolveLockfile).not.toHaveBeenCalled();
    expect(deps.fillBuiltins).not.toHaveBeenCalled();
  });

  it("adds Pyodide's pydantic, filled into the cache, for a body that imports it", async () => {
    const deps = fakes(["pydantic"], LOCKED);
    const resolved = await resolveSkillWasmPackages(deps, { lockfile: LOCKFILE, body: "" });
    expect(resolved._unsafeUnwrap()).toEqual({ builtins: ["httpx", "pydantic"], wheelDir: "/w" });
    expect(deps.fillBuiltins).toHaveBeenCalledWith(["pydantic"], undefined);
  });

  it("adds pydantic for a body that imports pydantic_core directly", async () => {
    const deps = fakes(["pydantic_core"], LOCKED);
    const resolved = await resolveSkillWasmPackages(deps, { lockfile: undefined, body: "" });
    expect(resolved._unsafeUnwrap()).toEqual({ builtins: ["pydantic"], wheelDir: null });
  });

  it("adds pydantic when the import scan fails, rather than fail the run", async () => {
    const deps = fakes([], LOCKED);
    deps.importRoots.mockResolvedValue(err("tree-sitter-python.wasm missing"));
    const resolved = await resolveSkillWasmPackages(deps, { lockfile: undefined, body: "" });
    expect(resolved._unsafeUnwrap()).toEqual({ builtins: ["pydantic"], wheelDir: null });
  });

  it("adds no second pydantic when the lockfile already loads it", async () => {
    const deps = fakes(["pydantic"], { builtins: ["pydantic"], wheelDir: "/w" });
    const resolved = await resolveSkillWasmPackages(deps, { lockfile: LOCKFILE, body: "" });
    expect(resolved._unsafeUnwrap()).toEqual({ builtins: ["pydantic"], wheelDir: "/w" });
    expect(deps.fillBuiltins).not.toHaveBeenCalled();
  });

  it("passes on a lockfile's failure, and a failure to fill pydantic", async () => {
    const lockfileDown = fakes(["pydantic"], LOCKED);
    lockfileDown.resolveLockfile.mockResolvedValue(
      err({ kind: "prefetch_failed", message: "down" }),
    );
    expect(
      (
        await resolveSkillWasmPackages(lockfileDown, { lockfile: LOCKFILE, body: "" })
      )._unsafeUnwrapErr(),
    ).toEqual({ kind: "prefetch_failed", message: "down" });

    const fillDown = fakes(["pydantic"], LOCKED);
    fillDown.fillBuiltins.mockResolvedValue(err({ kind: "prefetch_failed", message: "cdn" }));
    expect(
      (
        await resolveSkillWasmPackages(fillDown, { lockfile: undefined, body: "" })
      )._unsafeUnwrapErr(),
    ).toEqual({ kind: "prefetch_failed", message: "cdn" });
  });
});
