import { chmod, mkdtemp, rm, stat } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { HeadBucketCommand, type S3Client } from "@aws-sdk/client-s3";
import { CLIENT_VERSION } from "@vectorize-io/hindsight-client";
import { describe, expect, it, onTestFinished, vi } from "vitest";
import { mock } from "vitest-mock-extended";
import type { Database } from "../db/index.js";
import { logger } from "../logger.js";
import type { HindsightMemoryProvider } from "../memory/hindsight.js";
import { expectDefined } from "../test/assertions.js";
import {
  BOOT_PROBE_ATTEMPT_TIMEOUT_MS,
  BOOT_PROBE_DEADLINE_MS,
  BootCheckError,
  type BootClock,
  type BootProbeContext,
  checkDirWritable,
  checkHindsightAuth,
  checkHindsightClientVersion,
  checkHindsightVersion,
  checkInngestAuth,
  checkS3Bucket,
  checkS3KeyPair,
  checkUuidv7,
  HindsightCompatSchema,
  loadHindsightCompat,
  type ProbeFetch,
  runBootChecks,
  runHindsightChecks,
  type S3BucketTarget,
  systemBootClock,
} from "./checks.js";

interface FakeClock extends BootClock {
  sleeps: number[];
  timeouts: number[];
  /** Let the most recent attempt's timeout elapse: advance time and abort its signal. */
  expire(): void;
  /** Let time pass inside an attempt, as a slow response does. */
  advance(ms: number): void;
}

/** A clock whose `sleep` advances time instantly and whose timeouts fire on `expire()`. */
function fakeClock(options: { sleepOvershootMs: number } = { sleepOvershootMs: 0 }): FakeClock {
  let now = 0;
  let pending: { ms: number; controller: AbortController } | undefined;
  const sleeps: number[] = [];
  const timeouts: number[] = [];
  return {
    sleeps,
    timeouts,
    now: () => now,
    advance: (ms) => {
      now += ms;
    },
    sleep: async (ms, signal) => {
      if (signal.aborted) throw signal.reason;
      sleeps.push(ms);
      // A real timer can wake late; `sleepOvershootMs` models that.
      now += ms + options.sleepOvershootMs;
    },
    timeout: (ms) => {
      timeouts.push(ms);
      const controller = new AbortController();
      pending = { ms, controller };
      return controller.signal;
    },
    expire: () => {
      if (pending === undefined) return;
      now += pending.ms;
      pending.controller.abort(
        new DOMException("The operation was aborted due to timeout", "TimeoutError"),
      );
      pending = undefined;
    },
  };
}

/** A fetch whose status is chosen per request; `Error` makes it reject. */
function probeFetch(respond: (url: string, init: RequestInit | undefined) => number | Error) {
  return vi.fn<ProbeFetch>(async (url, init) => {
    const outcome = respond(url, init);
    if (outcome instanceof Error) throw outcome;
    return new Response(null, { status: outcome });
  });
}

/** A fetch that never answers: it settles only when its signal aborts, which it triggers. */
function hangingFetch(clock: FakeClock) {
  return vi.fn<ProbeFetch>(
    (_, init) =>
      new Promise<Response>((_resolve, reject) => {
        const signal = expectDefined(init?.signal, "probe signal");
        signal.addEventListener("abort", () => reject(signal.reason));
        clock.expire();
      }),
  );
}

/** A call that never settles and ignores every signal; the attempt's timeout still fires. */
function neverSettles<T>(clock: FakeClock): Promise<T> {
  const pending = new Promise<T>(() => undefined);
  // Expire only after the caller has started waiting on the call, so the
  // abort arrives while it is subscribed rather than before.
  setTimeout(() => clock.expire(), 0);
  return pending;
}

/** A probe context; `cancel` defaults to a signal nothing aborts. */
function context(
  clock: BootClock = fakeClock(),
  cancel: AbortSignal = new AbortController().signal,
) {
  return { clock, cancel };
}

function deps(fetchFn: ProbeFetch, clock: BootClock = fakeClock()) {
  return { fetch: fetchFn, ...context(clock) };
}

function bearer(init: RequestInit | undefined): string | null {
  return new Headers(init?.headers).get("authorization");
}

/** Spy on `logger.warn` for one test, restored however the test ends. */
function spyOnWarn() {
  const warn = vi.spyOn(logger, "warn");
  onTestFinished(() => warn.mockRestore());
  return warn;
}

/**
 * An S3 service error as the SDK builds it for `HeadBucket`: the response has
 * no body, so every status but 404 is named `Unknown`.
 */
function awsError(httpStatusCode: number, headers: Record<string, string> = {}): Error {
  const name = httpStatusCode === 404 ? "NotFound" : "Unknown";
  return Object.assign(new Error(name === "Unknown" ? "UnknownError" : name), {
    name,
    $metadata: { httpStatusCode },
    $response: { headers },
  });
}

function target(overrides: Partial<S3BucketTarget> = {}): S3BucketTarget {
  return { bucket: "cogmo-files", region: "us-east-1", ...overrides };
}

function credentialsProviderError(): Error {
  return Object.assign(new Error("Could not load credentials from any providers"), {
    name: "CredentialsProviderError",
  });
}

describe("checkHindsightAuth", () => {
  const url = "http://hindsight:8888";

  it("passes when anonymous requests are refused and the key is accepted", async () => {
    const fetchFn = probeFetch((_, init) => (bearer(init) === "Bearer k" ? 200 : 401));

    await expect(checkHindsightAuth(deps(fetchFn), url, "k")).resolves.toBeUndefined();

    expect(fetchFn.mock.calls.map(([u]) => u)).toEqual([
      "http://hindsight:8888/v1/default/banks",
      "http://hindsight:8888/v1/default/banks",
    ]);
  });

  it("gives every request of an attempt the attempt's timeout signal", async () => {
    const clock = fakeClock();
    const fetchFn = probeFetch((_, init) => (bearer(init) === "Bearer k" ? 200 : 401));

    await checkHindsightAuth(deps(fetchFn, clock), url, "k");

    expect(clock.timeouts).toEqual([BOOT_PROBE_ATTEMPT_TIMEOUT_MS]);
    const [first, second] = fetchFn.mock.calls.map(([, init]) => init?.signal);
    expect(first).toBeInstanceOf(AbortSignal);
    expect(second).toBe(first);
  });

  it("hard-fails at once when the server answers without a token", async () => {
    const clock = fakeClock();
    const fetchFn = probeFetch(() => 200);

    await expect(checkHindsightAuth(deps(fetchFn, clock), url, "k")).rejects.toThrow(
      /answered an unauthenticated request.*ApiKeyTenantExtension/,
    );
    expect(fetchFn).toHaveBeenCalledTimes(1);
    expect(clock.sleeps).toEqual([]);
  });

  it("keeps a received status when discarding the body fails", async () => {
    // The attempt signal can fire after the headers arrive, making `cancel()`
    // reject; the 2xx already received is still a verdict.
    const fetchFn = vi.fn<ProbeFetch>(
      async () =>
        new Response(
          new ReadableStream({
            cancel() {
              throw new DOMException("The operation was aborted due to timeout", "TimeoutError");
            },
          }),
          { status: 200 },
        ),
    );

    await expect(checkHindsightAuth(deps(fetchFn), url, "k")).rejects.toThrow(
      /answered an unauthenticated request/,
    );
  });

  it("hard-fails at once when the server rejects our key", async () => {
    const clock = fakeClock();
    const fetchFn = probeFetch(() => 401);

    const err = await checkHindsightAuth(deps(fetchFn, clock), url, "wrong").catch(
      (e: unknown) => e,
    );

    expect(err).toBeInstanceOf(BootCheckError);
    expect(String(err)).toMatch(/rejected HINDSIGHT_API_KEY/);
    expect(clock.sleeps).toEqual([]);
  });

  it("keeps a path prefix on the base URL", async () => {
    const fetchFn = probeFetch((_, init) => (bearer(init) === "Bearer k" ? 200 : 401));

    await checkHindsightAuth(deps(fetchFn), "https://gateway.internal/hindsight/", "k");

    expect(fetchFn.mock.calls.map(([u]) => u)).toEqual([
      "https://gateway.internal/hindsight/v1/default/banks",
      "https://gateway.internal/hindsight/v1/default/banks",
    ]);
  });

  it("keeps a query string after the probe path", async () => {
    const fetchFn = probeFetch((_, init) => (bearer(init) === "Bearer k" ? 200 : 401));

    await checkHindsightAuth(deps(fetchFn), "http://hindsight:8888/?tenant=a", "k");

    expect(fetchFn.mock.calls[0]?.[0]).toBe("http://hindsight:8888/v1/default/banks?tenant=a");
  });

  it("scrubs credentials a request error quotes, including a password containing @", async () => {
    const warn = spyOnWarn();
    const fetchFn = probeFetch(
      () => new TypeError("connect through http://operator:p@ss@proxy.internal:3128/ failed"),
    );

    const err = await checkHindsightAuth(deps(fetchFn), url, "k").catch((e: unknown) => e);

    expect(String(err)).toMatch(/http:\/\/REDACTED@proxy\.internal:3128/);
    expect(String(err)).not.toMatch(/operator|p@ss|ss@proxy/);
    expect(warn).toHaveBeenCalled();
    expect(JSON.stringify(warn.mock.calls)).not.toMatch(/operator|p@ss|ss@proxy/);
  });

  it("fails at once on a base URL with embedded credentials, without echoing them", async () => {
    const fetchFn = probeFetch(() => 401);

    const err = await checkHindsightAuth(
      deps(fetchFn),
      "http://operator:s3cret@hindsight:8888",
      "k",
    ).catch((e: unknown) => e);

    expect(err).toBeInstanceOf(BootCheckError);
    expect(String(err)).toMatch(/HINDSIGHT_URL must not embed credentials/);
    expect(String(err)).not.toContain("s3cret");
    expect(fetchFn).not.toHaveBeenCalled();
  });

  it("drops the query string from URLs in retry logs and the failure", async () => {
    const warn = spyOnWarn();
    const fetchFn = probeFetch(() => 502);

    const err = await checkHindsightAuth(
      deps(fetchFn),
      "https://gateway.internal/hindsight?token=abc123",
      "k",
    ).catch((e: unknown) => e);

    expect(String(err)).toMatch(
      /https:\/\/gateway\.internal\/hindsight\/v1\/default\/banks → HTTP 502/,
    );
    expect(String(err)).not.toContain("abc123");
    expect(warn).toHaveBeenCalled();
    expect(JSON.stringify(warn.mock.calls)).not.toContain("abc123");
    // The request itself still carries the query.
    expect(fetchFn.mock.calls[0]?.[0]).toContain("token=abc123");
  });

  it("retries an unreachable server and passes once it answers conclusively", async () => {
    const clock = fakeClock();
    let calls = 0;
    const fetchFn = probeFetch((_, init) => {
      calls += 1;
      if (calls <= 3) return new Error("ECONNREFUSED");
      return bearer(init) === "Bearer k" ? 200 : 401;
    });

    await expect(checkHindsightAuth(deps(fetchFn, clock), url, "k")).resolves.toBeUndefined();
    expect(clock.sleeps).toEqual([1_000, 2_000, 4_000]);
  });

  it("still catches a server that comes up in the last seconds before the deadline", async () => {
    const clock = fakeClock();
    // Down until 56s. Near the deadline attempts come every second, so the
    // attempt at 56s sees it up.
    const fetchFn = probeFetch((_, init) => {
      if (clock.now() < 56_000) return new Error("ECONNREFUSED");
      return bearer(init) === "Bearer k" ? 200 : 401;
    });

    await expect(checkHindsightAuth(deps(fetchFn, clock), url, "k")).resolves.toBeUndefined();
    expect(clock.now()).toBe(56_000);
  });

  it("never starts an attempt with less than a second to run, so the real reason survives", async () => {
    const clock = fakeClock();
    // The first 502 arrives 58.5s in: after the minimum wait, another attempt
    // would get only half a second to run.
    let first = true;
    const fetchFn = probeFetch(() => {
      if (first) {
        first = false;
        clock.advance(58_500);
      }
      return 502;
    });

    const err = await checkHindsightAuth(deps(fetchFn, clock), url, "k").catch((e: unknown) => e);

    expect(String(err)).toMatch(/within 60s.*→ HTTP 502/);
    expect(String(err)).not.toMatch(/timeout/);
    expect(Math.min(...clock.timeouts)).toBeGreaterThanOrEqual(1_000);
  });

  it("re-checks the minimum attempt time after a wait that wakes late", async () => {
    const clock = fakeClock({ sleepOvershootMs: 30 });
    // The first 502 arrives 58s in, leaving exactly the minimum wait plus the
    // minimum attempt; the wait then wakes 30ms late.
    let first = true;
    const fetchFn = probeFetch(() => {
      if (first) {
        first = false;
        clock.advance(58_000);
      }
      return 502;
    });

    const err = await checkHindsightAuth(deps(fetchFn, clock), url, "k").catch((e: unknown) => e);

    expect(String(err)).toMatch(/within 60s.*→ HTTP 502/);
    expect(Math.min(...clock.timeouts)).toBeGreaterThanOrEqual(1_000);
    expect(fetchFn).toHaveBeenCalledTimes(1);
  });

  it("stops once too little time is left to wait, without sleeping into the deadline", async () => {
    const clock = fakeClock();
    const warn = spyOnWarn();
    const fetchFn = probeFetch(() => new Error("ECONNREFUSED"));

    await expect(checkHindsightAuth(deps(fetchFn, clock), url, "k")).rejects.toThrow(
      /hindsight auth check could not reach a conclusive answer within 60s.*ECONNREFUSED/,
    );
    // The last attempt runs at 59s; with a second left, the check gives up
    // rather than waiting out that second.
    expect(clock.now()).toBe(59_000);
    expect(Math.max(...clock.sleeps)).toBe(10_000);
    expect(clock.sleeps.slice(-4)).toEqual([1_000, 1_000, 1_000, 1_000]);
    // One "retrying" warning per sleep: none is logged for a retry that never happens.
    expect(warn).toHaveBeenCalledTimes(clock.sleeps.length);
  });

  it("times out a request that never answers and fails closed exactly at the deadline", async () => {
    const clock = fakeClock();
    const fetchFn = hangingFetch(clock);

    await expect(checkHindsightAuth(deps(fetchFn, clock), url, "k")).rejects.toThrow(
      /within 60s.*timeout/,
    );
    expect(clock.now()).toBe(BOOT_PROBE_DEADLINE_MS);
    expect(Math.max(...clock.timeouts)).toBe(BOOT_PROBE_ATTEMPT_TIMEOUT_MS);
    // The last attempt gets only the time that is left.
    expect(clock.timeouts.at(-1)).toBe(4_000);
  });

  it.each([404, 502, 503])(
    "retries, then fails closed, when the anonymous request keeps getting HTTP %i",
    async (status) => {
      const fetchFn = probeFetch(() => status);

      await expect(checkHindsightAuth(deps(fetchFn), url, "k")).rejects.toThrow(
        new RegExp(`within 60s.*HTTP ${status}`),
      );
      // Never reaches the keyed probe: no request ever carries the token.
      expect(fetchFn.mock.calls.every(([, init]) => bearer(init) === null)).toBe(true);
      expect(fetchFn.mock.calls.length).toBeGreaterThan(1);
    },
  );

  it("fails closed when the keyed request keeps getting neither a 2xx nor a rejection", async () => {
    const fetchFn = probeFetch((_, init) => (bearer(init) === null ? 401 : 500));

    await expect(checkHindsightAuth(deps(fetchFn), url, "k")).rejects.toThrow(/HTTP 500/);
  });
});

describe("runBootChecks", () => {
  function parent(cancel: AbortSignal = new AbortController().signal) {
    return context(fakeClock(), cancel);
  }

  it("resolves when every check passes", async () => {
    await expect(
      runBootChecks(parent(), [async () => undefined, async () => undefined]),
    ).resolves.toBeUndefined();
  });

  it("rejects with the first failure, not a sibling's abandonment, and cancels the siblings", async () => {
    let siblingCancelled = false;
    const sibling = (checkContext: BootProbeContext) =>
      new Promise<void>((_resolve, reject) => {
        checkContext.cancel.addEventListener("abort", () => {
          siblingCancelled = true;
          reject(new BootCheckError("sibling abandoned"));
        });
      });

    await expect(
      runBootChecks(parent(), [
        sibling,
        async () => {
          throw new BootCheckError("S3 bucket missing");
        },
      ]),
    ).rejects.toThrow("S3 bucket missing");
    expect(siblingCancelled).toBe(true);
  });

  it("settles only once the cancelled checks have stopped", async () => {
    let siblingStopped = false;
    const sibling = (checkContext: BootProbeContext) =>
      new Promise<void>((resolveSibling) => {
        checkContext.cancel.addEventListener("abort", () => {
          setTimeout(() => {
            siblingStopped = true;
            resolveSibling();
          }, 10);
        });
      });

    await expect(
      runBootChecks(parent(), [
        sibling,
        async () => {
          throw new BootCheckError("inngest not keyed");
        },
      ]),
    ).rejects.toThrow("inngest not keyed");
    expect(siblingStopped).toBe(true);
  });

  it("handles a check that throws while starting like one that rejects", async () => {
    let firstStopped = false;
    const first = (checkContext: BootProbeContext) =>
      new Promise<void>((resolveFirst) => {
        checkContext.cancel.addEventListener("abort", () => {
          firstStopped = true;
          resolveFirst();
        });
      });
    const throwsWhileStarting = (): Promise<void> => {
      throw new BootCheckError("bad check arguments");
    };

    await expect(runBootChecks(parent(), [first, throwsWhileStarting])).rejects.toThrow(
      "bad check arguments",
    );
    expect(firstStopped).toBe(true);
  });

  it("passes a parent's cancellation on to every check", async () => {
    const parentCancel = new AbortController();
    parentCancel.abort(new Error("outer check failed"));
    const seen: boolean[] = [];

    await runBootChecks(parent(parentCancel.signal), [
      async (checkContext) => {
        seen.push(checkContext.cancel.aborted);
      },
    ]);

    expect(seen).toEqual([true]);
  });
});

describe("runHindsightChecks", () => {
  function later(ms: number): Promise<void> {
    return new Promise((resolveLater) => setTimeout(resolveLater, ms));
  }

  it("reports an auth failure ahead of a version failure that finished first", async () => {
    // An unkeyed server answers its open /version quickly.
    await expect(
      runHindsightChecks(context(), {
        auth: async () => {
          await later(10);
          throw new BootCheckError("Hindsight answered an unauthenticated request");
        },
        version: async () => {
          throw new BootCheckError("Hindsight server version 0.5.6 does not satisfy the range");
        },
      }),
    ).rejects.toThrow(/unauthenticated request/);
  });

  it("does not cancel the auth check when the version check fails", async () => {
    let authSawCancel: boolean | undefined;

    await expect(
      runHindsightChecks(context(), {
        auth: async (checkContext) => {
          await later(10);
          authSawCancel = checkContext.cancel.aborted;
        },
        version: async () => {
          throw new BootCheckError("version out of range");
        },
      }),
    ).rejects.toThrow("version out of range");
    expect(authSawCancel).toBe(false);
  });

  it("resolves when both pass", async () => {
    await expect(
      runHindsightChecks(context(), {
        auth: async () => undefined,
        version: async () => undefined,
      }),
    ).resolves.toBeUndefined();
  });

  it("passes a cancellation of its context to both checks", async () => {
    const outer = new AbortController();
    outer.abort(new Error("S3 check failed"));
    const seen: boolean[] = [];

    await runHindsightChecks(context(fakeClock(), outer.signal), {
      auth: async (checkContext) => {
        seen.push(checkContext.cancel.aborted);
      },
      version: async (checkContext) => {
        seen.push(checkContext.cancel.aborted);
      },
    });

    expect(seen).toEqual([true, true]);
  });
});

describe("checkS3KeyPair", () => {
  it.each([
    [undefined, undefined],
    ["AKIAEXAMPLE", "secret-value"],
  ])("accepts both keys or neither (%s / %s)", (accessKey, secretKey) => {
    expect(() => checkS3KeyPair(accessKey, secretKey)).not.toThrow();
  });

  it.each([
    ["AKIAEXAMPLE", undefined],
    [undefined, "secret-value"],
  ])("rejects a half-set pair (%s / %s) without echoing the key", (accessKey, secretKey) => {
    const err = (() => {
      try {
        checkS3KeyPair(accessKey, secretKey);
        return undefined;
      } catch (e: unknown) {
        return e;
      }
    })();

    expect(err).toBeInstanceOf(BootCheckError);
    expect(String(err)).toMatch(/S3_ACCESS_KEY and S3_SECRET_KEY must be set together/);
    expect(String(err)).not.toMatch(/AKIAEXAMPLE|secret-value/);
  });
});

describe("boot check cancellation", () => {
  const url = "http://hindsight:8888";

  it("stops at its next wait once cancelled, instead of sleeping it out", async () => {
    const clock = fakeClock();
    const siblings = new AbortController();
    let calls = 0;
    const fetchFn = probeFetch(() => {
      calls += 1;
      if (calls === 2) siblings.abort(new Error("S3 check failed"));
      return new Error("ECONNREFUSED");
    });

    await expect(
      checkHindsightAuth({ fetch: fetchFn, ...context(clock, siblings.signal) }, url, "k"),
    ).rejects.toThrow(/hindsight auth check abandoned: another boot check already failed/);
    expect(fetchFn).toHaveBeenCalledTimes(2);
    expect(clock.sleeps).toEqual([1_000]);
  });

  it("aborts the request in flight once cancelled", async () => {
    const clock = fakeClock();
    const siblings = new AbortController();
    const fetchFn = vi.fn<ProbeFetch>(
      (_, init) =>
        new Promise<Response>((_resolve, reject) => {
          const signal = expectDefined(init?.signal, "probe signal");
          signal.addEventListener("abort", () => reject(signal.reason));
          siblings.abort(new Error("S3 check failed"));
        }),
    );

    await expect(
      checkHindsightAuth({ fetch: fetchFn, ...context(clock, siblings.signal) }, url, "k"),
    ).rejects.toThrow(/abandoned/);
    // Ended by the cancellation, not by waiting out the attempt timeout.
    expect(clock.now()).toBe(0);
  });

  it("abandons an S3 call that ignores its signal once cancelled", async () => {
    const clock = fakeClock();
    const siblings = new AbortController();
    const s3 = mock<S3Client>();
    s3.send.mockImplementation((() => {
      const pending = new Promise(() => undefined);
      siblings.abort(new Error("hindsight check failed"));
      return pending;
    }) as never);

    await expect(checkS3Bucket(s3, target(), context(clock, siblings.signal))).rejects.toThrow(
      /S3 bucket "cogmo-files" check abandoned/,
    );
    expect(clock.now()).toBe(0);
  });

  it("does not probe at all when already cancelled", async () => {
    const siblings = new AbortController();
    siblings.abort(new Error("inngest check failed"));
    const fetchFn = probeFetch(() => 200);

    await expect(
      checkHindsightAuth({ fetch: fetchFn, ...context(fakeClock(), siblings.signal) }, url, "k"),
    ).rejects.toThrow(/abandoned/);
    expect(fetchFn).not.toHaveBeenCalled();
  });

  it("rejects the system clock's wait as soon as its signal aborts", async () => {
    const controller = new AbortController();
    const waiting = systemBootClock.sleep(60_000, controller.signal);
    controller.abort(new Error("cancelled"));

    await expect(waiting).rejects.toThrow();
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

    await expect(checkInngestAuth(deps(fetchFn), keyed)).resolves.toBeUndefined();

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

    await checkInngestAuth(deps(fetchFn), { ...keyed, dev: true, eventKey: undefined });

    expect(fetchFn).not.toHaveBeenCalled();
  });

  it("hard-fails before any request when a key is missing outside dev mode", async () => {
    const fetchFn = probeFetch(() => 200);

    await expect(
      checkInngestAuth(deps(fetchFn), { ...keyed, signingKey: undefined }),
    ).rejects.toThrow(/INNGEST_EVENT_KEY and INNGEST_SIGNING_KEY are required/);
    expect(fetchFn).not.toHaveBeenCalled();
  });

  it("hard-fails at once against a server that answers without a signing key", async () => {
    const clock = fakeClock();
    const fetchFn = probeFetch(() => 200);

    await expect(checkInngestAuth(deps(fetchFn, clock), keyed)).rejects.toThrow(
      /not enforcing keys/,
    );
    expect(clock.sleeps).toEqual([]);
  });

  it("hard-fails when the signing key is wrong", async () => {
    const fetchFn = keyedServer("other", "evt");

    await expect(checkInngestAuth(deps(fetchFn), keyed)).rejects.toThrow(
      /rejected INNGEST_SIGNING_KEY/,
    );
  });

  it("hard-fails when the event key is wrong", async () => {
    const fetchFn = keyedServer("abcd", "other");

    await expect(checkInngestAuth(deps(fetchFn), keyed)).rejects.toThrow(
      /rejected INNGEST_EVENT_KEY/,
    );
  });

  it("keeps a path prefix on the base URL for both the API and event probes", async () => {
    const fetchFn = keyedServer("abcd", "evt");

    await checkInngestAuth(deps(fetchFn), {
      ...keyed,
      baseUrl: "https://gateway.internal/inngest",
    });

    expect(fetchFn.mock.calls.map(([u]) => u)).toEqual([
      "https://gateway.internal/inngest/v1/events",
      "https://gateway.internal/inngest/v1/events",
      "https://gateway.internal/inngest/e/evt",
    ]);
  });

  it("retries an unreachable server and passes once it comes up keyed", async () => {
    const clock = fakeClock();
    let up = false;
    const server = keyedServer("abcd", "evt");
    const fetchFn = vi.fn<ProbeFetch>(async (u, init) => {
      if (!up) {
        up = true;
        throw new Error("ECONNREFUSED");
      }
      return server(u, init);
    });

    await expect(checkInngestAuth(deps(fetchFn, clock), keyed)).resolves.toBeUndefined();
    expect(clock.sleeps).toEqual([1_000]);
  });

  it("fails closed when the server stays unreachable", async () => {
    const fetchFn = probeFetch(() => new Error("ECONNREFUSED"));

    await expect(checkInngestAuth(deps(fetchFn), keyed)).rejects.toThrow(
      /inngest auth check could not reach a conclusive answer within 60s/,
    );
  });

  it("times out a request that never answers and fails closed exactly at the deadline", async () => {
    const clock = fakeClock();

    await expect(checkInngestAuth(deps(hangingFetch(clock), clock), keyed)).rejects.toThrow(
      /within 60s.*timeout/,
    );
    expect(clock.now()).toBe(BOOT_PROBE_DEADLINE_MS);
  });

  it.each([404, 502, 503])(
    "retries, then fails closed, when the anonymous request keeps getting HTTP %i",
    async (status) => {
      const fetchFn = probeFetch(() => status);

      await expect(checkInngestAuth(deps(fetchFn), keyed)).rejects.toThrow(
        new RegExp(`HTTP ${status}`),
      );
      expect(
        fetchFn.mock.calls.every(([u, init]) => !u.includes("/e/") && bearer(init) === null),
      ).toBe(true);
    },
  );

  it("never sends the event probe while the signed probe is unreachable", async () => {
    const fetchFn = probeFetch((_, init) =>
      bearer(init) === null ? 401 : new Error("socket hang up"),
    );

    await expect(checkInngestAuth(deps(fetchFn), keyed)).rejects.toThrow(/socket hang up/);
    expect(fetchFn.mock.calls.some(([u]) => u.includes("/e/"))).toBe(false);
  });

  it("keeps the event key out of logs and the failure when the event probe is inconclusive", async () => {
    const secretKey = "event-key-secret-7f3a";
    const warn = spyOnWarn();
    const fetchFn = probeFetch((u, init) => {
      if (u.includes("/e/")) return 404;
      return bearer(init) === "Bearer abcd" ? 200 : 401;
    });

    const err = await checkInngestAuth(deps(fetchFn), { ...keyed, eventKey: secretKey }).catch(
      (e: unknown) => e,
    );

    expect(err).toBeInstanceOf(BootCheckError);
    expect(String(err)).toMatch(/\/e\/REDACTED → HTTP 404/);
    expect(String(err)).not.toContain(secretKey);
    expect(warn).toHaveBeenCalled();
    expect(JSON.stringify(warn.mock.calls)).not.toContain(secretKey);
    // The request itself still goes to the real key.
    expect(fetchFn.mock.calls.some(([u]) => u.endsWith(`/e/${secretKey}`))).toBe(true);
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
  it("returns when HeadBucket succeeds, bounding the request with the attempt signal", async () => {
    const s3 = mock<S3Client>();
    s3.send.mockResolvedValue({} as never);
    await expect(checkS3Bucket(s3, target(), context())).resolves.toBeUndefined();
    expect(s3.send).toHaveBeenCalledWith(expect.any(HeadBucketCommand), {
      abortSignal: expect.any(AbortSignal),
    });
  });

  it.each([404, 403])(
    "fails at once, naming the bucket, on the store's HTTP %i verdict",
    async (status) => {
      const clock = fakeClock();
      const s3 = mock<S3Client>();
      s3.send.mockRejectedValue(awsError(status));

      const err = await checkS3Bucket(s3, target({ bucket: "missing" }), context(clock)).catch(
        (e: unknown) => e,
      );

      expect(err).toBeInstanceOf(BootCheckError);
      expect(String(err)).toMatch(new RegExp(`S3 bucket "missing" not reachable.*HTTP ${status}`));
      expect(clock.sleeps).toEqual([]);
    },
  );

  it("fails at once on a 301, naming the bucket's actual region", async () => {
    const clock = fakeClock();
    const s3 = mock<S3Client>();
    s3.send.mockRejectedValue(awsError(301, { "x-amz-bucket-region": "eu-west-2" }));

    const err = await checkS3Bucket(s3, target(), context(clock)).catch((e: unknown) => e);

    expect(err).toBeInstanceOf(BootCheckError);
    expect(String(err)).toMatch(
      /different region than S3_REGION \(us-east-1\): the bucket is in eu-west-2/,
    );
    expect(clock.sleeps).toEqual([]);
  });

  it("retries credentials that fail to load and passes once they do", async () => {
    // From EC2/ECS the chain reads a metadata endpoint that can be briefly slow.
    const clock = fakeClock();
    const s3 = mock<S3Client>();
    s3.send.mockRejectedValueOnce(credentialsProviderError()).mockResolvedValue({} as never);

    await expect(checkS3Bucket(s3, target(), context(clock))).resolves.toBeUndefined();
    expect(clock.sleeps).toEqual([1_000]);
  });

  it("fails closed with credentials guidance when credentials never load", async () => {
    const s3 = mock<S3Client>();
    s3.send.mockRejectedValue(credentialsProviderError());

    await expect(checkS3Bucket(s3, target(), context())).rejects.toThrow(
      /within 60s.*S3 credentials could not be loaded.*S3_ACCESS_KEY and S3_SECRET_KEY/,
    );
  });

  it("fails at once on a 400 that names the bucket's region", async () => {
    // The other shape S3 uses for a bucket in another region; the SDK's own
    // region redirect recognises it for HeadBucket.
    const clock = fakeClock();
    const s3 = mock<S3Client>();
    s3.send.mockRejectedValue(awsError(400, { "x-amz-bucket-region": "eu-west-2" }));

    const err = await checkS3Bucket(s3, target(), context(clock)).catch((e: unknown) => e);

    expect(err).toBeInstanceOf(BootCheckError);
    expect(String(err)).toMatch(
      /different region than S3_REGION \(us-east-1\): the bucket is in eu-west-2/,
    );
    expect(clock.sleeps).toEqual([]);
  });

  it("retries a 400 whose region header names the configured region", async () => {
    // S3 sends x-amz-bucket-region for existing buckets, so a same-region 400
    // (an expired token, a transient RequestTimeout) carries it too.
    const clock = fakeClock();
    const s3 = mock<S3Client>();
    s3.send
      .mockRejectedValueOnce(awsError(400, { "x-amz-bucket-region": "us-east-1" }))
      .mockResolvedValue({} as never);

    await expect(
      checkS3Bucket(s3, target({ region: "us-east-1" }), context(clock)),
    ).resolves.toBeUndefined();
    expect(clock.sleeps).toEqual([1_000]);
  });

  it("retries a temporary redirect", async () => {
    const clock = fakeClock();
    const s3 = mock<S3Client>();
    s3.send.mockRejectedValueOnce(awsError(307)).mockResolvedValue({} as never);

    await expect(checkS3Bucket(s3, target(), context(clock))).resolves.toBeUndefined();
    expect(clock.sleeps).toEqual([1_000]);
  });

  it("retries a 400, which may be S3's transient RequestTimeout", async () => {
    const clock = fakeClock();
    const s3 = mock<S3Client>();
    s3.send.mockRejectedValueOnce(awsError(400)).mockResolvedValue({} as never);

    await expect(checkS3Bucket(s3, target(), context(clock))).resolves.toBeUndefined();
    expect(clock.sleeps).toEqual([1_000]);
  });

  it("retries a network failure and passes once the store answers", async () => {
    const clock = fakeClock();
    const s3 = mock<S3Client>();
    s3.send
      .mockRejectedValueOnce(new Error("connect ECONNREFUSED"))
      .mockRejectedValueOnce(awsError(503))
      .mockResolvedValue({} as never);

    await expect(checkS3Bucket(s3, target(), context(clock))).resolves.toBeUndefined();
    expect(clock.sleeps).toEqual([1_000, 2_000]);
  });

  it("retries a throttled request instead of treating 429 as a verdict", async () => {
    const clock = fakeClock();
    const s3 = mock<S3Client>();
    s3.send.mockRejectedValueOnce(awsError(429)).mockResolvedValue({} as never);

    await expect(checkS3Bucket(s3, target(), context(clock))).resolves.toBeUndefined();
    expect(clock.sleeps).toEqual([1_000]);
  });

  it("times out a HeadBucket that ignores its signal and fails closed at the deadline", async () => {
    // Credential resolution runs before the request and never sees the signal.
    const clock = fakeClock();
    const s3 = mock<S3Client>();
    s3.send.mockImplementation((() => neverSettles(clock)) as never);

    await expect(checkS3Bucket(s3, target(), context(clock))).rejects.toThrow(
      /within 60s.*timeout/,
    );
    expect(clock.now()).toBe(BOOT_PROBE_DEADLINE_MS);
  });

  it("fails closed when the store stays unreachable", async () => {
    const s3 = mock<S3Client>();
    s3.send.mockRejectedValue(new Error("connect ECONNREFUSED"));

    await expect(checkS3Bucket(s3, target(), context())).rejects.toThrow(
      /S3 bucket "cogmo-files" check could not reach a conclusive answer within 60s/,
    );
  });
});

describe("checkHindsightVersion", () => {
  function memoryReporting(version: string): HindsightMemoryProvider {
    const m = mock<HindsightMemoryProvider>();
    m.getServerVersion.mockResolvedValue(version);
    return m;
  }

  const range = ">=0.6.0 <0.7.0";

  function check(memory: HindsightMemoryProvider, pin: string = range) {
    return checkHindsightVersion(memory, pin, context());
  }

  it("passes when server version satisfies the range at the lower bound", async () => {
    await expect(check(memoryReporting("0.6.0"))).resolves.toBeUndefined();
  });

  it("passes the attempt's timeout signal to the version request", async () => {
    const m = memoryReporting("0.6.0");
    await check(m);
    expect(m.getServerVersion).toHaveBeenCalledWith(expect.any(AbortSignal));
  });

  it("passes when server version is inside the range", async () => {
    await expect(check(memoryReporting("0.6.4"))).resolves.toBeUndefined();
  });

  it("throws when server version is below the range", async () => {
    await expect(check(memoryReporting("0.5.6"))).rejects.toThrow(BootCheckError);
    await expect(check(memoryReporting("0.5.6"))).rejects.toThrow(/does not satisfy/);
  });

  it("throws when server version is at the exclusive upper bound", async () => {
    await expect(check(memoryReporting("0.7.0"))).rejects.toThrow(BootCheckError);
  });

  it("throws when server version is well above the range", async () => {
    await expect(check(memoryReporting("1.0.0"))).rejects.toThrow(BootCheckError);
  });

  it("treats prereleases as in-range when the stable would be in-range", async () => {
    // Hindsight may report `0.6.0-rc.1` from a prerelease build.
    // includePrerelease: true is required because node-semver's default
    // ranges exclude prereleases.
    await expect(check(memoryReporting("0.6.0-rc.1"))).resolves.toBeUndefined();
  });

  it("supports caret-range syntax in the pin", async () => {
    await expect(check(memoryReporting("0.6.4"), "^0.6.0")).resolves.toBeUndefined();
    await expect(check(memoryReporting("0.7.0"), "^0.6.0")).rejects.toThrow(BootCheckError);
  });

  it("coerces server versions with build metadata or extra suffixes", async () => {
    // `0.6.0+build.7` is unusual but valid; `semver.valid` returns null
    // for some shapes upstream might pick. `coerce` extracts the leading
    // X.Y.Z so wire-compat stays the question being answered.
    await expect(check(memoryReporting("0.6.0+build.7"))).resolves.toBeUndefined();
  });

  it("retries an unreadable /version and checks the range once it answers", async () => {
    const clock = fakeClock();
    const m = mock<HindsightMemoryProvider>();
    m.getServerVersion.mockRejectedValueOnce(new Error("fetch failed")).mockResolvedValue("0.6.1");

    await expect(checkHindsightVersion(m, range, context(clock))).resolves.toBeUndefined();
    expect(clock.sleeps).toEqual([1_000]);
  });

  it("times out a /version request that ignores its signal and fails closed at the deadline", async () => {
    const clock = fakeClock();
    const m = mock<HindsightMemoryProvider>();
    m.getServerVersion.mockImplementation(() => neverSettles(clock));

    await expect(checkHindsightVersion(m, range, context(clock))).rejects.toThrow(
      /within 60s.*timeout/,
    );
    expect(clock.now()).toBe(BOOT_PROBE_DEADLINE_MS);
  });

  it("fails closed when /version stays unreadable", async () => {
    const m = mock<HindsightMemoryProvider>();
    m.getServerVersion.mockRejectedValue(new Error("fetch failed"));

    await expect(check(m)).rejects.toThrow(
      /hindsight version check could not reach a conclusive answer within 60s.*fetch failed/,
    );
  });

  it("hard-fails when the server reports a version semver can't parse or coerce", async () => {
    await expect(check(memoryReporting("not-a-version"))).rejects.toThrow(BootCheckError);
  });
});
