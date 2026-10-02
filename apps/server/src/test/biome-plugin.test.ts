import { execFile } from "node:child_process";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { z } from "zod";

const execFileAsync = promisify(execFile);

// biome + biome-plugins are workspace-root tooling; this test lives in the
// cogmo package (apps/server), so resolve them from the repo root, not cwd.
const REPO_ROOT = fileURLToPath(new URL("../../../..", import.meta.url));
const BIOME_BIN = resolve(REPO_ROOT, "node_modules/.bin/biome");

const PluginEntrySchema = z.union([
  z.string(),
  z.object({ path: z.string(), includes: z.array(z.string()).optional() }),
]);
const RepoBiomeConfigSchema = z.object({ plugins: z.array(PluginEntrySchema) });

interface BiomeResult {
  exitCode: number;
  output: string;
}

async function runBiomeLint(target: string): Promise<BiomeResult> {
  try {
    const { stdout, stderr } = await execFileAsync(BIOME_BIN, ["lint", target], {
      env: process.env,
    });
    return { exitCode: 0, output: stdout + stderr };
  } catch (e) {
    const err = e as { stdout?: string; stderr?: string; code?: number };
    return { exitCode: err.code ?? 1, output: (err.stdout ?? "") + (err.stderr ?? "") };
  }
}

/**
 * The repo's own `plugins` entries, paths made absolute. Each plugin's
 * `includes` scoping comes along unchanged, so the tests exercise the scoping
 * the repo actually lints with.
 */
function repoPlugins(): ReadonlyArray<z.infer<typeof PluginEntrySchema>> {
  const config = RepoBiomeConfigSchema.parse(
    JSON.parse(readFileSync(resolve(REPO_ROOT, "biome.json"), "utf8")),
  );
  return config.plugins.map((entry) =>
    typeof entry === "string"
      ? resolve(REPO_ROOT, entry)
      : { ...entry, path: resolve(REPO_ROOT, entry.path) },
  );
}

/**
 * The main config excludes `test/fixtures/**` from biome's file scope, so a
 * fixture there would be silently skipped. Fixtures go into a tempdir with a
 * self-contained `biome.json` carrying the repo's plugin entries instead —
 * biome resolves config from the target's directory, so the tempdir's wins.
 */
let tmp: string;

beforeAll(() => {
  tmp = mkdtempSync(join(tmpdir(), "biome-plugin-test-"));
  writeFileSync(
    join(tmp, "biome.json"),
    JSON.stringify({
      $schema: "https://biomejs.dev/schemas/2.4.15/schema.json",
      plugins: repoPlugins(),
      linter: { enabled: true, rules: { recommended: false } },
    }),
  );
});

afterAll(() => {
  if (tmp) rmSync(tmp, { recursive: true, force: true });
});

async function lintSource(relPath: string, source: string): Promise<BiomeResult> {
  const target = join(tmp, relPath);
  mkdirSync(dirname(target), { recursive: true });
  writeFileSync(target, source);
  return runBiomeLint(target);
}

describe("biome plugin: no-unsafe-cast", () => {
  it("fires on `as unknown as` in a production file", async () => {
    const { exitCode, output } = await lintSource(
      "violation.ts",
      "export const x = {} as unknown as { foo: string };\n",
    );

    expect(exitCode, `biome should exit non-zero; output:\n${output}`).not.toBe(0);
    expect(output).toMatch(/Avoid `as unknown as`/);
    expect(output).toMatch(/violation\.ts:\d+/);
  });

  it("does NOT fire on `as unknown as` in a *.test.ts file", async () => {
    const { exitCode, output } = await lintSource(
      "violation.test.ts",
      "export const x = {} as unknown as { foo: string };\n",
    );

    expect(exitCode, `biome should exit zero on test files; output:\n${output}`).toBe(0);
    expect(output).not.toMatch(/Avoid `as unknown as`/);
  });

  it("respects `// biome-ignore lint/plugin/no-unsafe-cast` suppressions", async () => {
    const { exitCode, output } = await lintSource(
      "suppressed.ts",
      [
        "// biome-ignore lint/plugin/no-unsafe-cast: smoke-test fixture",
        "export const x = {} as unknown as { foo: string };",
        "",
      ].join("\n"),
    );

    expect(exitCode, `suppression should silence the plugin; output:\n${output}`).toBe(0);
  });
});

describe("biome plugin: no-default-params", () => {
  const DEFAULT_PARAM = /Avoid default parameter values/;

  it.each([
    ["a function parameter", "export function f(x = 1) {\n  return x;\n}\n"],
    ["an arrow parameter", "export const f = (x = 1) => x;\n"],
    ["a method parameter", "export class C {\n  m(x = 1) {\n    return x;\n  }\n}\n"],
    [
      "a destructuring default inside a parameter",
      "export function f({ x = 1 }: { x?: number }) {\n  return x;\n}\n",
    ],
    [
      "an array destructuring default inside a parameter",
      "export function f([x = 1]: number[]) {\n  return x;\n}\n",
    ],
    [
      "a nested array destructuring default inside a parameter",
      "export function f({ xs: [x = 1] }: { xs: number[] }) {\n  return x;\n}\n",
    ],
    [
      "a non-empty options default",
      "export function f(opts: { x: number } = { x: 1 }) {\n  return opts;\n}\n",
    ],
  ])("fires on %s", async (_label, source) => {
    const { exitCode, output } = await lintSource("src/defaults.ts", source);

    expect(exitCode, `biome should exit non-zero; output:\n${output}`).not.toBe(0);
    expect(output).toMatch(DEFAULT_PARAM);
  });

  it.each([
    ["an empty options bag", "export function f(opts: { x?: number } = {}) {\n  return opts;\n}\n"],
    [
      "a destructuring default outside a parameter",
      "export function f(o: { x?: number }) {\n  const { x = 1 } = o;\n  return x;\n}\n",
    ],
    [
      "an array destructuring default outside a parameter",
      "export function f(xs: number[]) {\n  const [x = 1] = xs;\n  return x;\n}\n",
    ],
    [
      "an array destructuring parameter without a default",
      "export function f([x]: number[]) {\n  return x;\n}\n",
    ],
  ])("does NOT fire on %s", async (_label, source) => {
    const { exitCode, output } = await lintSource("src/clean.ts", source);

    expect(exitCode, `biome should exit zero; output:\n${output}`).toBe(0);
    expect(output).not.toMatch(DEFAULT_PARAM);
  });

  it.each([
    ["a *.test.ts file", "src/defaults.test.ts"],
    ["a test/ helper", "src/test/helper.ts"],
  ])("does NOT fire in %s", async (_label, relPath) => {
    const { exitCode, output } = await lintSource(
      relPath,
      "export function f(x = 1) {\n  return x;\n}\n",
    );

    expect(exitCode, `biome should exit zero on test code; output:\n${output}`).toBe(0);
    expect(output).not.toMatch(DEFAULT_PARAM);
  });

  it("respects `// biome-ignore lint/plugin/no-default-params` suppressions", async () => {
    const { exitCode, output } = await lintSource(
      "src/suppressed-default.ts",
      [
        "export function f(",
        "  // biome-ignore lint/plugin/no-default-params: smoke-test fixture",
        "  x = 1,",
        ") {",
        "  return x;",
        "}",
        "",
      ].join("\n"),
    );

    expect(exitCode, `suppression should silence the plugin; output:\n${output}`).toBe(0);
  });
});

describe("biome plugin: no-discriminant-switch", () => {
  const DISPATCH = /Dispatch on a discriminated union with ts-pattern/;

  it.each(["kind", "status"])('fires on `switch (x["%s"])`', async (field) => {
    const { exitCode, output } = await lintSource(
      `src/switch-computed-${field}.ts`,
      `export function f(x: { ${field}: "a" | "b" }) {\n  switch (x["${field}"]) {\n    case "a":\n      return 1;\n    case "b":\n      return 2;\n  }\n}\n`,
    );

    expect(exitCode, `biome should exit non-zero; output:\n${output}`).not.toBe(0);
    expect(output).toMatch(DISPATCH);
  });

  it.each(["kind", "status"])("fires on `switch (x.%s)`", async (field) => {
    const { exitCode, output } = await lintSource(
      `src/switch-${field}.ts`,
      `export function f(x: { ${field}: "a" | "b" }) {\n  switch (x.${field}) {\n    case "a":\n      return 1;\n    case "b":\n      return 2;\n  }\n}\n`,
    );

    expect(exitCode, `biome should exit non-zero; output:\n${output}`).not.toBe(0);
    expect(output).toMatch(DISPATCH);
  });

  it("does NOT fire on `switch (x.type)`", async () => {
    const { exitCode, output } = await lintSource(
      "src/switch-type.ts",
      'export function f(x: { type: "a" | "b" }) {\n  switch (x.type) {\n    case "a":\n      return 1;\n    case "b":\n      return 2;\n  }\n}\n',
    );

    expect(exitCode, `biome should exit zero; output:\n${output}`).toBe(0);
    expect(output).not.toMatch(DISPATCH);
  });

  it("respects `// biome-ignore lint/plugin/no-discriminant-switch` suppressions", async () => {
    const { exitCode, output } = await lintSource(
      "src/suppressed-switch.ts",
      [
        'export function f(x: { kind: "a" }) {',
        "  // biome-ignore lint/plugin/no-discriminant-switch: smoke-test fixture",
        "  switch (x.kind) {",
        '    case "a":',
        "      return 1;",
        "  }",
        "}",
        "",
      ].join("\n"),
    );

    expect(exitCode, `suppression should silence the plugin; output:\n${output}`).toBe(0);
  });
});

describe("biome plugin: no-inline-test-container", () => {
  const INLINE = /Define test containers in `apps\/server\/dev\/containers\.ts`/;
  const GENERIC = [
    'import { GenericContainer } from "testcontainers";',
    'export const c = new GenericContainer("mirror.gcr.io/library/redis:8-alpine");',
    "",
  ].join("\n");

  it.each([
    ["`new GenericContainer(...)` in a test", "src/inline.integration.test.ts", GENERIC],
    ["`new GenericContainer(...)` in a test helper", "src/test/helper.ts", GENERIC],
    [
      "`GenericContainer.fromDockerfile(...)`",
      "src/from-dockerfile.integration.test.ts",
      'import { GenericContainer } from "testcontainers";\nexport const b = GenericContainer.fromDockerfile(".");\n',
    ],
  ])("fires on %s", async (_label, relPath, source) => {
    const { exitCode, output } = await lintSource(relPath, source);

    expect(exitCode, `biome should exit non-zero; output:\n${output}`).not.toBe(0);
    expect(output).toMatch(INLINE);
  });

  it.each([
    ["dev/containers.ts", "apps/server/dev/containers.ts"],
    ["the e2e setup exception", "apps/server/test/e2e-setup.ts"],
  ])("does NOT fire in %s", async (_label, relPath) => {
    const { exitCode, output } = await lintSource(relPath, GENERIC);

    expect(exitCode, `biome should exit zero; output:\n${output}`).toBe(0);
    expect(output).not.toMatch(INLINE);
  });
});
