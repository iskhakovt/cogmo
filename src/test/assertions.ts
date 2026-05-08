/**
 * Tiny narrowing helpers for tests.
 *
 * The codebase uses `noUncheckedIndexedAccess` and ts-reset (which makes
 * `JSON.parse` return `unknown`), so test code can't blindly index into
 * arrays / mock-call lists or read fields off parsed JSON. These helpers
 * narrow with a runtime check so the type system follows along — no `as`
 * casts at the call site, no `!` assertions hiding real undefined cases.
 */

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
