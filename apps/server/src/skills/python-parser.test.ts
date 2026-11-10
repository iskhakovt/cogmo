import { copyFile, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import {
  __resetParserForTests,
  configurePythonParser,
  loadPythonParser,
  withPythonTree,
} from "./python-parser.js";
import { vendoredGrammarPath } from "./vendored-grammar.js";

const VENDORED = vendoredGrammarPath(process.cwd());

let dir: string;

beforeAll(async () => {
  dir = await mkdtemp(join(tmpdir(), "cogmo-python-parser-"));
});

afterAll(async () => {
  await rm(dir, { recursive: true, force: true });
});

beforeEach(() => {
  configurePythonParser(VENDORED);
  __resetParserForTests();
});

describe("loadPythonParser", () => {
  it("loads the configured grammar", async () => {
    await expect(loadPythonParser()).resolves.toBeUndefined();
  });

  it("throws naming the grammar when it cannot load, and loads again once it can", async () => {
    const missing = join(dir, "no-such-grammar.wasm");
    configurePythonParser(missing);
    await expect(loadPythonParser()).rejects.toThrow(
      `the Python grammar at ${missing} did not load: ENOENT`,
    );

    configurePythonParser(VENDORED);
    await expect(loadPythonParser()).resolves.toBeUndefined();
  });

  it("names the grammar when its bytes do not load", async () => {
    const truncated = join(dir, "truncated.wasm");
    await writeFile(truncated, "\0asm");
    configurePythonParser(truncated);
    await expect(loadPythonParser()).rejects.toThrow(
      `the Python grammar at ${truncated} did not load`,
    );
  });

  it("retries a failed load from the same path rather than caching the failure", async () => {
    const later = join(dir, "later.wasm");
    configurePythonParser(later);
    await expect(loadPythonParser()).rejects.toThrow(/did not load/);

    await copyFile(VENDORED, later);
    await expect(loadPythonParser()).resolves.toBeUndefined();
  });

  it("throws when no grammar is configured", async () => {
    vi.resetModules();
    const unconfigured = await import("./python-parser.js");
    await expect(unconfigured.loadPythonParser()).rejects.toThrow(
      "the Python grammar is not configured",
    );
    await expect(unconfigured.withPythonTree("x = 1\n", () => "parsed")).rejects.toThrow(
      "the Python grammar is not configured",
    );
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

  it("parses with the grammar configured last", async () => {
    configurePythonParser(join(dir, "missing.wasm"));
    await expect(withPythonTree("x = 1\n", () => "parsed")).rejects.toThrow(/missing\.wasm/);

    configurePythonParser(VENDORED);
    expect(await withPythonTree("x = 1\n", () => "parsed")).toBe("parsed");
  });
});
