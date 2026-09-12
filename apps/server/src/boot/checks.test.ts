import { chmod, mkdtemp, rm, stat } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { HeadBucketCommand, type S3Client } from "@aws-sdk/client-s3";
import { CLIENT_VERSION } from "@vectorize-io/hindsight-client";
import { describe, expect, it, vi } from "vitest";
import { mock } from "vitest-mock-extended";
import type { Database } from "../db/index.js";
import type { HindsightMemoryProvider } from "../memory/hindsight.js";
import { expectDefined } from "../test/assertions.js";
import {
  BootCheckError,
  checkDirWritable,
  checkHindsightAuth,
  checkHindsightClientVersion,
  checkHindsightVersion,
  checkInngestAuth,
  checkS3Bucket,
  checkUuidv7,
  HindsightCompatSchema,
  loadHindsightCompat,
  type ProbeFetch,
} from "./checks.js";

/** A fetch whose status is chosen per request; `Error` makes it reject. */
function probeFetch(respond: (url: string, init: RequestInit | undefined) => number | Error) {
  return vi.fn<ProbeFetch>(async (url, init) => {
    const outcome = respond(url, init);
    if (outcome instanceof Error) throw outcome;
    return new Response(null, { status: outcome });
  });
}

function bearer(init: RequestInit | undefined): string | null {
  return new Headers(init?.headers).get("authorization");
}

describe("checkHindsightAuth", () => {
  const url = "http://hindsight:8888";

  it("passes when anonymous requests are refused and the key is accepted", async () => {
    const fetchFn = probeFetch((_, init) => (bearer(init) === "Bearer k" ? 200 : 401));

    await expect(checkHindsightAuth(fetchFn, url, "k")).resolves.toBeUndefined();

    expect(fetchFn.mock.calls.map(([u]) => u)).toEqual([
      "http://hindsight:8888/v1/default/banks",
      "http://hindsight:8888/v1/default/banks",
    ]);
  });

  it("hard-fails when the server answers without a token", async () => {
    const fetchFn = probeFetch(() => 200);

    await expect(checkHindsightAuth(fetchFn, url, "k")).rejects.toThrow(
      /answered an unauthenticated request.*ApiKeyTenantExtension/,
    );
    expect(fetchFn).toHaveBeenCalledTimes(1);
  });

  it("hard-fails when the server rejects our key", async () => {
    const fetchFn = probeFetch(() => 401);

    const err = await checkHindsightAuth(fetchFn, url, "wrong").catch((e: unknown) => e);

    expect(err).toBeInstanceOf(BootCheckError);
    expect(String(err)).toMatch(/rejected HINDSIGHT_API_KEY/);
  });

  it("soft-fails when the server is unreachable", async () => {
    const fetchFn = probeFetch(() => new Error("ECONNREFUSED"));

    await expect(checkHindsightAuth(fetchFn, url, "k")).resolves.toBeUndefined();
  });

  it("keeps a path prefix on the base URL", async () => {
    const fetchFn = probeFetch((_, init) => (bearer(init) === "Bearer k" ? 200 : 401));

    await checkHindsightAuth(fetchFn, "https://gateway.internal/hindsight/", "k");

    expect(fetchFn.mock.calls.map(([u]) => u)).toEqual([
      "https://gateway.internal/hindsight/v1/default/banks",
      "https://gateway.internal/hindsight/v1/default/banks",
    ]);
  });

  it.each([404, 502, 503])(
    "soft-fails without the keyed probe when the anonymous request gets HTTP %i",
    async (status) => {
      const fetchFn = probeFetch(() => status);

      await expect(checkHindsightAuth(fetchFn, url, "k")).resolves.toBeUndefined();
      expect(fetchFn).toHaveBeenCalledTimes(1);
    },
  );

  it("soft-fails when the keyed request gets neither a 2xx nor a rejection", async () => {
    const fetchFn = probeFetch((_, init) => (bearer(init) === null ? 401 : 500));

    await expect(checkHindsightAuth(fetchFn, url, "k")).resolves.toBeUndefined();
    expect(fetchFn).toHaveBeenCalledTimes(2);
  });
});

describe("checkInngestAuth", () => {
  const keyed = {
    baseUrl: "http://inngest:8288",
    dev: false,
    eventKey: "evt",
    signingKey: "abcd",
  };

  /** A keyed server: API needs the signing key, `/e/<key>` needs the event key. */
  function keyedServer(signingKey: string, eventKey: string) {
    return probeFetch((u, init) => {
      if (u.includes("/e/")) return u.endsWith(`/e/${eventKey}`) ? 200 : 401;
      return bearer(init) === `Bearer ${signingKey}` ? 200 : 401;
    });
  }

  it("passes against a server enforcing the keys we hold, probing with an empty batch", async () => {
    const fetchFn = keyedServer("abcd", "evt");

    await expect(checkInngestAuth(fetchFn, keyed)).resolves.toBeUndefined();

    const eventCall = expectDefined(
      fetchFn.mock.calls.find(([u]) => u.includes("/e/")),
      "event probe",
    );
    expect(eventCall[0]).toBe("http://inngest:8288/e/evt");
    // An empty batch is accepted without creating an event.
    expect(eventCall[1]).toMatchObject({ method: "POST", body: "[]" });
  });

  it("skips every probe under INNGEST_DEV", async () => {
    const fetchFn = probeFetch(() => 200);

    await checkInngestAuth(fetchFn, { ...keyed, dev: true, eventKey: undefined });

    expect(fetchFn).not.toHaveBeenCalled();
  });

  it("hard-fails before any request when a key is missing outside dev mode", async () => {
    const fetchFn = probeFetch(() => 200);

    await expect(checkInngestAuth(fetchFn, { ...keyed, signingKey: undefined })).rejects.toThrow(
      /INNGEST_EVENT_KEY and INNGEST_SIGNING_KEY are required/,
    );
    expect(fetchFn).not.toHaveBeenCalled();
  });

  it("hard-fails against a server that answers without a signing key", async () => {
    const fetchFn = probeFetch(() => 200);

    await expect(checkInngestAuth(fetchFn, keyed)).rejects.toThrow(/not enforcing keys/);
  });

  it("hard-fails when the signing key is wrong", async () => {
    const fetchFn = keyedServer("other", "evt");

    await expect(checkInngestAuth(fetchFn, keyed)).rejects.toThrow(/rejected INNGEST_SIGNING_KEY/);
  });

  it("hard-fails when the event key is wrong", async () => {
    const fetchFn = keyedServer("abcd", "other");

    await expect(checkInngestAuth(fetchFn, keyed)).rejects.toThrow(/rejected INNGEST_EVENT_KEY/);
  });

  it("soft-fails when the server is unreachable", async () => {
    const fetchFn = probeFetch(() => new Error("ECONNREFUSED"));

    await expect(checkInngestAuth(fetchFn, keyed)).resolves.toBeUndefined();
  });

  it("keeps a path prefix on the base URL for both the API and event probes", async () => {
    const fetchFn = keyedServer("abcd", "evt");

    await checkInngestAuth(fetchFn, { ...keyed, baseUrl: "https://gateway.internal/inngest" });

    expect(fetchFn.mock.calls.map(([u]) => u)).toEqual([
      "https://gateway.internal/inngest/v1/events",
      "https://gateway.internal/inngest/v1/events",
      "https://gateway.internal/inngest/e/evt",
    ]);
  });

  it.each([404, 502, 503])(
    "soft-fails without further probes when the anonymous request gets HTTP %i",
    async (status) => {
      const fetchFn = probeFetch(() => status);

      await expect(checkInngestAuth(fetchFn, keyed)).resolves.toBeUndefined();
      expect(fetchFn).toHaveBeenCalledTimes(1);
    },
  );

  it("does not send the event probe when the signed probe is unreachable", async () => {
    const fetchFn = probeFetch((_, init) =>
      bearer(init) === null ? 401 : new Error("socket hang up"),
    );

    await expect(checkInngestAuth(fetchFn, keyed)).resolves.toBeUndefined();
    expect(fetchFn.mock.calls.some(([u]) => u.includes("/e/"))).toBe(false);
  });

  it("soft-fails when the event probe gets neither a 2xx nor a rejection", async () => {
    const fetchFn = probeFetch((u, init) => {
      if (u.includes("/e/")) return 404;
      return bearer(init) === "Bearer abcd" ? 200 : 401;
    });

    await expect(checkInngestAuth(fetchFn, keyed)).resolves.toBeUndefined();
    expect(fetchFn).toHaveBeenCalledTimes(3);
  });
});

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

  it("rejects semantic wildcards beyond literal `*`", () => {
    // Anything that matches every version, regardless of how the user
    // spelled it — pinning these defeats the boot-time compat check.
    for (const wildcard of ["*", "x", "X", ">=0.0.0", ">=0.0.0-0", ">=0.0.0-pre"]) {
      expect(() => HindsightCompatSchema.parse(wildcard)).toThrow();
    }
  });
});

describe("checkHindsightClientVersion", () => {
  const range = ">=0.8.0 <0.9.0";

  it("passes when the client version satisfies the range", () => {
    expect(() => checkHindsightClientVersion(range, "0.8.1")).not.toThrow();
  });

  it("throws when the client version is below the range", () => {
    expect(() => checkHindsightClientVersion(range, "0.7.2")).toThrow(BootCheckError);
    expect(() => checkHindsightClientVersion(range, "0.7.2")).toThrow(
      /outside the supported range/,
    );
  });

  it("throws when the client version is at the exclusive upper bound", () => {
    expect(() => checkHindsightClientVersion(range, "0.9.0")).toThrow(BootCheckError);
  });

  it("coerces build metadata before comparing", () => {
    expect(() => checkHindsightClientVersion(range, "0.8.1+build.9")).not.toThrow();
  });

  it("throws when the client reports an unparseable version", () => {
    expect(() => checkHindsightClientVersion(range, "not-a-version")).toThrow(BootCheckError);
  });

  it("the bundled client version agrees with the pinned compat range", () => {
    // Drift guard: bumping @vectorize-io/hindsight-client without bumping
    // cogmo.hindsightCompat (or vice versa) fails here, in CI, before boot.
    expect(() => checkHindsightClientVersion(loadHindsightCompat(), CLIENT_VERSION)).not.toThrow();
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

describe("checkDirWritable", () => {
  it("creates a missing directory and returns when writable", async () => {
    const base = await mkdtemp(join(tmpdir(), "cogmo-checkdir-"));
    const target = join(base, "nested", "dir");
    try {
      await expect(checkDirWritable(target, "TEST_DIR")).resolves.toBeUndefined();
      const s = await stat(target);
      expect(s.isDirectory()).toBe(true);
    } finally {
      await rm(base, { recursive: true, force: true });
    }
  });

  it("returns when the directory already exists and is writable", async () => {
    const base = await mkdtemp(join(tmpdir(), "cogmo-checkdir-"));
    try {
      await expect(checkDirWritable(base, "TEST_DIR")).resolves.toBeUndefined();
    } finally {
      await rm(base, { recursive: true, force: true });
    }
  });

  it("throws BootCheckError naming the env var when the path is unwritable", async () => {
    // chmod 0o555 (r-x for everyone, no write) on a directory the test
    // user owns — DAC respects mode bits even for the owner, so mkdir
    // of a child path returns EACCES deterministically. Skip if running
    // as root (CI container) since root bypasses DAC.
    if (process.getuid?.() === 0) return;
    const base = await mkdtemp(join(tmpdir(), "cogmo-checkdir-ro-"));
    try {
      await chmod(base, 0o555);
      const target = join(base, "child");
      await expect(checkDirWritable(target, "TEST_DIR")).rejects.toThrow(BootCheckError);
      await expect(checkDirWritable(target, "TEST_DIR")).rejects.toThrow(/TEST_DIR/);
    } finally {
      await chmod(base, 0o755);
      await rm(base, { recursive: true, force: true });
    }
  });

  it("rejects an existing directory with write but no execute permission", async () => {
    // 0o600 (rw, no x) on an existing dir — mkdir -p is a no-op so the
    // check falls through to access(W_OK | X_OK), which must reject.
    // Without the X_OK part of the check this would silently pass at
    // boot and then EACCES at the first socket()/open() inside the dir.
    if (process.getuid?.() === 0) return;
    const base = await mkdtemp(join(tmpdir(), "cogmo-checkdir-nox-"));
    try {
      await chmod(base, 0o600);
      await expect(checkDirWritable(base, "TEST_DIR")).rejects.toThrow(BootCheckError);
    } finally {
      await chmod(base, 0o755);
      await rm(base, { recursive: true, force: true });
    }
  });

  it("preserves the underlying error as `cause`", async () => {
    if (process.getuid?.() === 0) return;
    const base = await mkdtemp(join(tmpdir(), "cogmo-checkdir-cause-"));
    try {
      await chmod(base, 0o555);
      const target = join(base, "child");
      const err = await checkDirWritable(target, "TEST_DIR").catch((e: unknown) => e);
      expect(err).toBeInstanceOf(BootCheckError);
      expect((err as Error).cause).toBeInstanceOf(Error);
    } finally {
      await chmod(base, 0o755);
      await rm(base, { recursive: true, force: true });
    }
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
