import { readdirSync, readFileSync } from "node:fs";
import { dirname, join, relative, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import picomatch from "picomatch";
import * as R from "remeda";
import { describe, expect, it } from "vitest";
import { parse as parseYaml } from "yaml";
import { z } from "zod";

// The `Schema ⇒ design doc` CI job lists the files that define stored shape.
// Its list of Zod schema modules is hand-written; this test derives the same
// set from the `jsonbZod(` call sites and fails when the two drift.

const REPO_ROOT = fileURLToPath(new URL("../../../..", import.meta.url));
const SERVER_SRC = resolve(REPO_ROOT, "apps/server/src");

const WorkflowSchema = z.object({
  jobs: z.object({
    "schema-docs": z.object({
      steps: z.array(
        z.object({ id: z.string().optional(), with: z.record(z.string(), z.unknown()).optional() }),
      ),
    }),
  }),
});
const FiltersSchema = z.object({ schema: z.array(z.string()), design: z.array(z.string()) });

interface SchemaFilter {
  globs: ReadonlyArray<string>;
  /** paths-filter's predicate: a file must match some pattern, or with `every`, all of them. */
  matches: (path: string) => boolean;
}

function schemaFilter(): SchemaFilter {
  const workflow = WorkflowSchema.parse(
    parseYaml(readFileSync(resolve(REPO_ROOT, ".github/workflows/ci.yml"), "utf8")),
  );
  const filterStep = workflow.jobs["schema-docs"].steps.find((s) => s.id === "filter");
  const globs = FiltersSchema.parse(parseYaml(z.string().parse(filterStep?.with?.filters))).schema;
  const matchers = globs.map((g) => picomatch(g, { dot: true }));
  const every = filterStep?.with?.["predicate-quantifier"] === "every";
  return {
    globs,
    matches: (path) => (every ? matchers.every((m) => m(path)) : matchers.some((m) => m(path))),
  };
}

function sourceFiles(dir: string): ReadonlyArray<string> {
  return readdirSync(dir, { withFileTypes: true }).flatMap((entry) => {
    const path = join(dir, entry.name);
    if (entry.isDirectory()) return sourceFiles(path);
    return entry.name.endsWith(".ts") && !entry.name.endsWith(".test.ts") ? [path] : [];
  });
}

/** The module that declares `name`, as seen from `file`: an import's target, or `file` itself. */
function declaringModule(file: string, source: string, name: string): string {
  const imports = source.matchAll(/import\s+(?:type\s+)?\{([^}]*)\}\s+from\s+"([^"]+)"/g);
  for (const [, names = "", from = ""] of imports) {
    const imported = names.split(",").map((n) =>
      n
        .trim()
        .split(/\s+as\s+/)
        .at(-1),
    );
    if (imported.includes(name) && from.startsWith(".")) {
      return resolve(dirname(file), from.replace(/\.js$/, ".ts"));
    }
  }
  return file;
}

function repoPath(abs: string): string {
  return relative(REPO_ROOT, abs);
}

/** Every module declaring a Zod schema passed to `jsonbZod(name, Schema)`. */
function jsonbZodSchemaModules(): ReadonlyArray<{ schema: string; module: string }> {
  return R.pipe(
    sourceFiles(SERVER_SRC),
    R.flatMap((file) => {
      const source = readFileSync(file, "utf8");
      return [...source.matchAll(/jsonbZod\(\s*"[^"]+",\s*([A-Za-z_$][\w$]*)/g)].map(
        ([, schema = ""]) => ({ schema, module: declaringModule(file, source, schema) }),
      );
    }),
    R.uniqueBy((e) => `${e.schema}@${e.module}`),
  );
}

describe("schema-docs CI filter", () => {
  const { globs, matches } = schemaFilter();
  const sources = jsonbZodSchemaModules();

  it("finds the jsonbZod call sites", () => {
    expect(sources.length).toBeGreaterThan(20);
  });

  it("resolves every jsonbZod schema to a module that declares it", () => {
    const unresolved = sources.filter(
      ({ schema, module }) =>
        !new RegExp(`\\b(?:const|let|var)\\s+${schema}\\b`).test(readFileSync(module, "utf8")),
    );
    expect(unresolved).toEqual([]);
  });

  it("covers every module that declares a jsonbZod schema", () => {
    const missing = R.unique(sources.map((s) => repoPath(s.module))).filter((p) => !matches(p));
    expect(missing).toEqual([]);
  });

  it("lists no module that no longer declares a jsonbZod schema", () => {
    const sourcePaths = new Set(sources.map((s) => repoPath(s.module)));
    const stale = globs.filter((g) => !picomatch.scan(g).isGlob && !sourcePaths.has(g));
    expect(stale).toEqual([]);
  });

  it("covers store schemas and migrations, not their tests", () => {
    expect(matches("apps/server/src/transport/store/schema.ts")).toBe(true);
    expect(matches("apps/server/src/agent/store/schema/transcript.ts")).toBe(true);
    expect(matches("apps/server/src/agent/store/schema/nested/dir/x.ts")).toBe(true);
    expect(matches("apps/server/migrations/0001_futuristic_joshua_kane.sql")).toBe(true);
    expect(matches("apps/server/migrations/meta/_journal.json")).toBe(true);
    expect(matches("apps/server/src/agent/store/schema/transcript.test.ts")).toBe(false);
    expect(matches("apps/server/src/agent/store/index.ts")).toBe(false);
  });
});
