import { describe, expect, it } from "vitest";
import { mapManifestResourceLimits } from "./runtime.js";

describe("mapManifestResourceLimits", () => {
  it("maps memory_mb to bytes and cpu_shares to cpus", () => {
    expect(mapManifestResourceLimits({ memory_mb: 1024, cpu_shares: 2, wall_clock_s: 30 })).toEqual(
      { memory_bytes: 1024 * 1024 * 1024, cpus: 2 },
    );
  });

  it("maps cpu_shares alone — regression: was silently dropped before", () => {
    expect(mapManifestResourceLimits({ cpu_shares: 3 })).toEqual({ cpus: 3 });
  });

  it("maps memory_mb alone", () => {
    expect(mapManifestResourceLimits({ memory_mb: 512 })).toEqual({
      memory_bytes: 512 * 1024 * 1024,
    });
  });

  it("returns an empty object when the manifest declares no resources", () => {
    expect(mapManifestResourceLimits(undefined)).toEqual({});
    expect(mapManifestResourceLimits({})).toEqual({});
  });

  it("ignores wall_clock_s — that's threaded as a separate runOnSysboxContainer arg", () => {
    expect(mapManifestResourceLimits({ wall_clock_s: 60 })).toEqual({});
  });
});
