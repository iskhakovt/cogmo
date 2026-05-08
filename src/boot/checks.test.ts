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
  it("reads cogmo.hindsightCompat from the project package.json", () => {
    const compat = loadHindsightCompat();
    expect(HindsightCompatSchema.parse(compat)).toEqual(compat);
    // Real package.json should pin a sane non-empty range.
    expect(compat.min).toMatch(/^\d+\.\d+\.\d+/);
    expect(compat.max).toMatch(/^\d+\.\d+\.\d+/);
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

  it("throws BootCheckError when HeadBucket fails", async () => {
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

  const compat = { min: "0.6.0", max: "0.7.0" };

  it("passes when server version is exactly min", async () => {
    await expect(checkHindsightVersion(memoryReporting("0.6.0"), compat)).resolves.toBeUndefined();
  });

  it("passes when server version is inside the range", async () => {
    await expect(checkHindsightVersion(memoryReporting("0.6.4"), compat)).resolves.toBeUndefined();
  });

  it("throws when server version is below min", async () => {
    await expect(checkHindsightVersion(memoryReporting("0.5.6"), compat)).rejects.toThrow(
      BootCheckError,
    );
    await expect(checkHindsightVersion(memoryReporting("0.5.6"), compat)).rejects.toThrow(
      /outside the supported range/,
    );
  });

  it("throws when server version is at max (max is exclusive)", async () => {
    await expect(checkHindsightVersion(memoryReporting("0.7.0"), compat)).rejects.toThrow(
      BootCheckError,
    );
  });

  it("throws when server version is above max", async () => {
    await expect(checkHindsightVersion(memoryReporting("1.0.0"), compat)).rejects.toThrow(
      BootCheckError,
    );
  });

  it("compares major-then-minor-then-patch", async () => {
    // 0.10.0 must NOT be treated as < 0.6.0 (string compare would do that)
    await expect(
      checkHindsightVersion(memoryReporting("0.10.0"), { min: "0.6.0", max: "0.20.0" }),
    ).resolves.toBeUndefined();
  });

  it("tolerates trailing prerelease/build suffix on server version", async () => {
    // Hindsight may report "0.6.0+abc1234" or "0.6.0-rc.1" — leading
    // semver still parses cleanly.
    await expect(
      checkHindsightVersion(memoryReporting("0.6.0-rc.1"), compat),
    ).resolves.toBeUndefined();
  });

  it("soft-fails (no throw) when /version probe rejects", async () => {
    const m = mock<HindsightMemoryProvider>();
    m.getServerVersion.mockRejectedValue(new Error("fetch failed"));
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    await expect(checkHindsightVersion(m, compat)).resolves.toBeUndefined();
    warn.mockRestore();
  });

  it("hard-fails on unparseable server version", async () => {
    await expect(checkHindsightVersion(memoryReporting("not-a-version"), compat)).rejects.toThrow(
      BootCheckError,
    );
  });
});
