import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
  __resetParserForTests,
  __setWasmPathForTests,
  loadPythonParser,
  withPythonTree,
} from "./python-parser.js";

afterEach(() => {
  __setWasmPathForTests(null);
  __resetParserForTests();
});

describe("loadPythonParser", () => {
  it("loads the vendored grammar", async () => {
    await expect(loadPythonParser()).resolves.toBeUndefined();
  });

  it("throws when the grammar cannot load, and loads again once it can", async () => {
    __setWasmPathForTests(join("/nonexistent", "tree-sitter-python.wasm"));
    __resetParserForTests();
    await expect(loadPythonParser()).rejects.toThrow(/tree-sitter-python\.wasm/);

    __setWasmPathForTests(null);
    await expect(loadPythonParser()).resolves.toBeUndefined();
  });
});

describe("withPythonTree", () => {
  it("hands the root to the reader and returns its result", async () => {
    expect(await withPythonTree("x = 1\n", (root) => root?.namedChild(0)?.type)).toBe(
      "expression_statement",
    );
  });

  it("propagates the reader's throw", async () => {
    await expect(
      withPythonTree("x = 1\n", () => {
        throw new Error("walk panic");
      }),
    ).rejects.toThrow("walk panic");
  });
});
