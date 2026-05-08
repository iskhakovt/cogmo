import { HeadBucketCommand, type S3Client } from "@aws-sdk/client-s3";
import { describe, expect, it, vi } from "vitest";
import { mock } from "vitest-mock-extended";
import type { Database } from "../db/index.js";
import type { HindsightMemoryProvider } from "../memory/hindsight.js";
import {
  BootCheckError,
  checkHindsightVersion,
  checkS3Bucket,
  checkUuidv7,
  HindsightCompatSchema,
  loadHindsightCompat,
} from "./checks.js";

describe("loadHindsightCompat", () => {
  it("reads cogmo.hindsightCompat from the project package.json as a valid semver range", () => {
    const range = loadHindsightCompat();
    // Real package.json should pin a valid node-semver range.
    expect(() => HindsightCompatSchema.parse(range)).not.toThrow();
    expect(typeof range).toBe("string");
    expect(range.length).toBeGreaterThan(0);
  });
});

describe("HindsightCompatSchema", () => {
  it("accepts node-semver ranges", () => {
    expect(() => HindsightCompatSchema.parse(">=0.6.0 <0.7.0")).not.toThrow();
    expect(() => HindsightCompatSchema.parse("^0.6.0")).not.toThrow();
    expect(() => HindsightCompatSchema.parse("0.6.x")).not.toThrow();
  });

  it("rejects strings that aren't valid ranges", () => {
    expect(() => HindsightCompatSchema.parse("not-a-range")).toThrow();
    expect(() => HindsightCompatSchema.parse("")).toThrow();
  });
});

describe("checkUuidv7", () => {
  it("returns when uuidv7() succeeds", async () => {
    const db = mock<Database>();
    db.execute.mockResolvedValue([{ uuidv7: "01..." }] as never);
    await expect(checkUuidv7(db)).resolves.toBeUndefined();
  });

  it("throws BootCheckError with a fix hint when uuidv7() fails", async () => {
    const db = mock<Database>();
    db.execute.mockRejectedValue(new Error("function uuidv7() does not exist"));
    await expect(checkUuidv7(db)).rejects.toThrow(BootCheckError);
    await expect(checkUuidv7(db)).rejects.toThrow(/init-db\.sql/);
  });
});

describe("checkS3Bucket", () => {
  it("returns when HeadBucket succeeds", async () => {
    const s3 = mock<S3Client>();
    s3.send.mockResolvedValue({} as never);
    await expect(checkS3Bucket(s3, "cogmo-files")).resolves.toBeUndefined();
    expect(s3.send).toHaveBeenCalledWith(expect.any(HeadBucketCommand));
  });

  it("throws BootCheckError with the bucket name when HeadBucket fails", async () => {
    const s3 = mock<S3Client>();
    s3.send.mockRejectedValue(new Error("NoSuchBucket"));
    await expect(checkS3Bucket(s3, "missing")).rejects.toThrow(BootCheckError);
    await expect(checkS3Bucket(s3, "missing")).rejects.toThrow(/missing/);
  });
});

describe("checkHindsightVersion", () => {
  function memoryReporting(version: string): HindsightMemoryProvider {
    const m = mock<HindsightMemoryProvider>();
    m.getServerVersion.mockResolvedValue(version);
    return m;
  }

  const range = ">=0.6.0 <0.7.0";

  it("passes when server version satisfies the range at the lower bound", async () => {
    await expect(checkHindsightVersion(memoryReporting("0.6.0"), range)).resolves.toBeUndefined();
  });

  it("passes when server version is inside the range", async () => {
    await expect(checkHindsightVersion(memoryReporting("0.6.4"), range)).resolves.toBeUndefined();
  });

  it("throws when server version is below the range", async () => {
    await expect(checkHindsightVersion(memoryReporting("0.5.6"), range)).rejects.toThrow(
      BootCheckError,
    );
    await expect(checkHindsightVersion(memoryReporting("0.5.6"), range)).rejects.toThrow(
      /does not satisfy/,
    );
  });

  it("throws when server version is at the exclusive upper bound", async () => {
    await expect(checkHindsightVersion(memoryReporting("0.7.0"), range)).rejects.toThrow(
      BootCheckError,
    );
  });

  it("throws when server version is well above the range", async () => {
    await expect(checkHindsightVersion(memoryReporting("1.0.0"), range)).rejects.toThrow(
      BootCheckError,
    );
  });

  it("treats prereleases as in-range when the stable would be in-range", async () => {
    // Hindsight may report `0.6.0-rc.1` from a prerelease build.
    // includePrerelease: true is required because node-semver's default
    // ranges exclude prereleases.
    await expect(
      checkHindsightVersion(memoryReporting("0.6.0-rc.1"), range),
    ).resolves.toBeUndefined();
  });

  it("supports caret-range syntax in the pin", async () => {
    await expect(
      checkHindsightVersion(memoryReporting("0.6.4"), "^0.6.0"),
    ).resolves.toBeUndefined();
    await expect(checkHindsightVersion(memoryReporting("0.7.0"), "^0.6.0")).rejects.toThrow(
      BootCheckError,
    );
  });

  it("coerces server versions with build metadata or extra suffixes", async () => {
    // `0.6.0+build.7` is unusual but valid; `semver.valid` returns null
    // for some shapes upstream might pick. `coerce` extracts the leading
    // X.Y.Z so wire-compat stays the question being answered.
    await expect(
      checkHindsightVersion(memoryReporting("0.6.0+build.7"), range),
    ).resolves.toBeUndefined();
  });

  it("soft-fails (no throw) when /version probe rejects", async () => {
    const m = mock<HindsightMemoryProvider>();
    m.getServerVersion.mockRejectedValue(new Error("fetch failed"));
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    await expect(checkHindsightVersion(m, range)).resolves.toBeUndefined();
    warn.mockRestore();
  });

  it("hard-fails when the server reports a version semver can't parse or coerce", async () => {
    await expect(checkHindsightVersion(memoryReporting("not-a-version"), range)).rejects.toThrow(
      BootCheckError,
    );
  });
});
