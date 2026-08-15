import { describe, expect, it } from "vitest";
import pkg from "../../node_modules/pyodide/package.json" with { type: "json" };

/**
 * Pin the pyodide release line we test against.
 *
 * Pyodide's major tracks the CPython version it embeds — the 314 line is
 * Python 3.14 — and a major carries both a new interpreter and a new package
 * ABI, so the bundled wheel set turns over with it. Minors within a line still
 * move the JS API and interpreter patch level.
 *
 * When this test fails, bump the constant deliberately: re-record fixtures,
 * re-validate `ctx.*` round-tripping and interrupt-buffer / wall-clock-cap
 * behavior, and check `pyodide-compat.ts` still resolves the packages skills
 * declare against the new `pyodide-lock.json`.
 */
const EXPECTED_PYODIDE = "314.";

describe("pyodide version pin", () => {
  it(`is on the ${EXPECTED_PYODIDE}x line`, () => {
    expect(pkg.version).toMatch(new RegExp(`^${EXPECTED_PYODIDE.replace(/\./g, "\\.")}`));
  });
});
