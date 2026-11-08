import { describe, expect, it } from "vitest";
import { loadBundledPackages } from "./pyodide-compat.js";
import { checkRuntimePins, RUNTIME_PACKAGES } from "./runtime-packages.js";

describe("RUNTIME_PACKAGES", () => {
  it.each(Object.entries(RUNTIME_PACKAGES))(
    "pins %s at the version Pyodide carries (the skills image's pytest checks the image)",
    async (name, version) => {
      const bundled = await loadBundledPackages();
      expect(bundled._unsafeUnwrap().packages.get(name)?.version).toBe(version);
    },
  );
});

describe("checkRuntimePins", () => {
  it("accepts a lockfile with no runtime package, or one at the runtime's version", () => {
    expect(checkRuntimePins("httpx==0.28.1 \\\n    --hash=sha256:aa\n").isOk()).toBe(true);
    expect(
      checkRuntimePins(
        "pydantic==2.12.5 \\\n    --hash=sha256:aa\npydantic-core==2.41.5 \\\n    --hash=sha256:bb\n",
      ).isOk(),
    ).toBe(true);
  });

  it("refuses one of pydantic's requirements below its floor, and accepts it at or above", () => {
    expect(
      checkRuntimePins("typing-extensions==4.13.2 \\\n    --hash=sha256:aa\n")._unsafeUnwrapErr(),
    ).toMatch(
      /^runtime_package_conflict: requirements\.lock pins typing-extensions==4\.13\.2 \(pydantic needs >=4\.14\.1\)/,
    );
    expect(checkRuntimePins("typing-extensions==4.14.1\nannotated-types==0.10.0\n").isOk()).toBe(
      true,
    );
  });

  it("refuses a lockfile pinning a runtime package at another version, whatever its spelling", () => {
    const pinned = checkRuntimePins(
      "Pydantic_Core==2.45.0 \\\n    --hash=sha256:aa\npydantic==2.14.3 \\\n    --hash=sha256:bb\n",
    );
    expect(pinned._unsafeUnwrapErr()).toBe(
      "runtime_package_conflict: requirements.lock pins pydantic-core==2.45.0 (the runtime's is 2.41.5), pydantic==2.14.3 (the runtime's is 2.12.5). Skills share the runtime's pydantic; declare pydantic==2.12.5 in dependencies so the compile resolves around it, and recompile.",
    );
  });
});
