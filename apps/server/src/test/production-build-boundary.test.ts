import { readdirSync, readFileSync } from "node:fs";
import { dirname, join, relative, resolve, sep } from "node:path";
import { describe, expect, it } from "vitest";

/**
 * The production image copies `src/` without `src/test/` or `*.test.ts`
 * (`.dockerignore`), and `pnpm build` typechecks what it copied. A source file
 * that imports from `src/test/` therefore compiles here and fails the image
 * build, which PR CI doesn't run.
 */
const SRC = resolve(import.meta.dirname, "..");
const TEST_DIR = join(SRC, "test");
const RELATIVE_SPECIFIER = /(?:\bfrom\s*|\bimport\s*\(\s*)["'](\.{1,2}\/[^"']+)["']/g;

function shippedSources(dir: string): string[] {
  return readdirSync(dir, { withFileTypes: true }).flatMap((entry) => {
    const path = join(dir, entry.name);
    if (entry.isDirectory()) return path === TEST_DIR ? [] : shippedSources(path);
    return entry.name.endsWith(".ts") && !entry.name.endsWith(".test.ts") ? [path] : [];
  });
}

function importsIntoTestDir(file: string): string[] {
  const source = readFileSync(file, "utf8");
  return [...source.matchAll(RELATIVE_SPECIFIER)].flatMap((match) => {
    const specifier = match[1];
    if (specifier === undefined) return [];
    const target = resolve(dirname(file), specifier);
    return target === TEST_DIR || target.startsWith(TEST_DIR + sep) ? [specifier] : [];
  });
}

describe("production build boundary", () => {
  it("ships no source file that imports from src/test", () => {
    const offenders = shippedSources(SRC).flatMap((file) =>
      importsIntoTestDir(file).map((specifier) => `${relative(SRC, file)} → ${specifier}`),
    );
    expect(offenders).toEqual([]);
  });
});
