import { describe, expect, it } from "vitest";
import pkg from "../../node_modules/pyodide/package.json" with { type: "json" };

/**
 * Pin the pyodide major+minor we test against. Pyodide ships breaking
 * changes in JS API and Python interpreter version across minors (e.g.
 * 0.27→0.28→0.29 each had behavioral diffs). When this test fails,
 * intentionally bump the constant after re-recording fixtures and
 * re-validating ctx.* + interrupt-buffer behavior.
 */
const EXPECTED_PYODIDE = "0.29.";

describe("pyodide version pin", () => {
  it(`is on the ${EXPECTED_PYODIDE}x line`, () => {
    expect(pkg.version).toMatch(new RegExp(`^${EXPECTED_PYODIDE.replace(/\./g, "\\.")}`));
  });
});
