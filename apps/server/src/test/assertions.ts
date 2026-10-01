/**
 * Tiny narrowing helpers for tests.
 *
 * The codebase uses `noUncheckedIndexedAccess` and ts-reset (which makes
 * `JSON.parse` return `unknown`), so test code can't blindly index into
 * arrays / mock-call lists or read fields off parsed JSON. These helpers
 * narrow with a runtime check so the type system follows along — no `as`
 * casts at the call site, no `!` assertions hiding real undefined cases.
 */

import type { TextOptions } from "@clack/prompts";
import type { Result } from "neverthrow";

import type { Adapter, StreamingAdapter } from "../transport/types.js";

/**
 * Narrow an adapter-setup result to a batch `Adapter`. `AdapterSetupResult.adapter`
 * is `Adapter | StreamingAdapter` (the web channel is streaming-only); batch-adapter
 * tests that exercise `deliver` use this to drop the streaming arm without a cast.
 * Keyed on `deliver` (not `isStreamingAdapter`) so Telegram — which implements
 * both — still narrows correctly.
 */
export function asBatchAdapter(adapter: Adapter | StreamingAdapter): Adapter {
  if (!("deliver" in adapter)) {
    throw new Error("expected a batch Adapter (no `deliver` method present)");
  }
  return adapter;
}

/**
 * Throw if `value` is `null` / `undefined`, otherwise return it narrowed.
 * Use for `arr[i]`, `map.get(k)`, `.find(...)`, `.mock.calls[0]`, etc.
 */
export function expectDefined<T>(value: T | null | undefined, label = "value"): T {
  if (value === null || value === undefined) {
    throw new Error(`expected ${label} to be defined`);
  }
  return value;
}

/**
 * Return an `Ok`'s value, or throw naming the `Err`. For fixture setup through
 * a `Result`-returning call: `store.createProfile(trx, …).then(expectOk)`.
 */
export function expectOk<T, E>(result: Result<T, E>): T {
  if (result.isErr()) throw new Error(`expected Ok, got Err ${JSON.stringify(result.error)}`);
  return result.value;
}

/**
 * Narrow a discriminated-union value to a specific variant. The `asserts`
 * annotation propagates the narrowing without a cast at the call site.
 *
 * ```ts
 * const ev = events[4];
 * assertKind(ev, "plan_ready");
 * expect(ev.plan).toBe("..."); // ev: Extract<CodingEvent, { kind: "plan_ready" }>
 * ```
 */
export function assertKind<U extends { kind: string }, K extends U["kind"]>(
  value: U | null | undefined,
  kind: K,
): asserts value is Extract<U, { kind: K }> {
  if (value === null || value === undefined) {
    throw new Error(`expected kind '${kind}', got null/undefined`);
  }
  if (value.kind !== kind) {
    throw new Error(`expected kind '${kind}', got '${value.kind}'`);
  }
}

/**
 * {@link assertKind} for unions discriminated on `status`, such as
 * `RegisterResult` and `SkillRunResult`. Throws naming the value when the
 * status differs, so a test failure shows the errors a rejection carried.
 */
export function assertStatus<U extends { status: string }, S extends U["status"]>(
  value: U | null | undefined,
  status: S,
): asserts value is U & { status: S } {
  if (value === null || value === undefined) {
    throw new Error(`expected status '${status}', got null/undefined`);
  }
  if (value.status !== status) {
    throw new Error(`expected status '${status}', got ${JSON.stringify(value)}`);
  }
}

/**
 * Await `promise`, throwing if it is still pending after `ms` — for a wait
 * whose failure mode is hanging forever. A rejection propagates. Real timers
 * only.
 */
export async function resolvesWithin<T>(
  promise: Promise<T>,
  ms: number,
  label: string,
): Promise<T> {
  let timer: NodeJS.Timeout | undefined;
  const timeout = new Promise<never>((_, reject) => {
    timer = setTimeout(() => reject(new Error(`expected ${label} within ${ms}ms`)), ms);
  });
  try {
    return await Promise.race([promise, timeout]);
  } finally {
    clearTimeout(timer);
  }
}

/**
 * Run a `@clack/prompts` string `validate` option. The option is a union of a
 * validator function, which may return a promise, and a Standard Schema object;
 * wizard prompts always pass a synchronous function, so this narrows to it
 * (throwing otherwise) and returns its result.
 */
export function runClackValidate(
  validate: TextOptions["validate"],
  value: string,
): string | Error | undefined {
  if (typeof validate !== "function") {
    throw new Error("expected a clack validate function, got a schema or undefined");
  }
  const result = validate(value);
  if (result instanceof Promise) {
    throw new Error("expected a synchronous clack validate function, got an async one");
  }
  return result;
}
