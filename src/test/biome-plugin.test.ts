import { execFile } from "node:child_process";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { promisify } from "node:util";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

const execFileAsync = promisify(execFile);

const BIOME_BIN = resolve("node_modules/.bin/biome");
const PLUGIN_ABS_PATH = resolve("biome-plugins/no-unsafe-cast.grit");

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
 * The plugin lives in the project's `biome.json` but the main config also
 * excludes `test/fixtures/**` from biome's file scope, so a fixture under
 * `test/fixtures/` would be silently skipped by `biome lint <path>`. We
 * sidestep that by materialising both a self-contained `biome.json` and
 * the fixture file into a tempdir for the duration of the test — biome
 * resolves config from the target's directory, so the tempdir's config
 * (pointing at the plugin via absolute path) wins.
 */
describe("biome plugin: no-unsafe-cast", () => {
  let tmp: string;

  beforeAll(() => {
    tmp = mkdtempSync(join(tmpdir(), "biome-plugin-test-"));
    writeFileSync(
      join(tmp, "biome.json"),
      JSON.stringify({
        $schema: "https://biomejs.dev/schemas/2.4.15/schema.json",
        plugins: [PLUGIN_ABS_PATH],
        linter: { enabled: true, rules: { recommended: false } },
      }),
    );
  });

  afterAll(() => {
    if (tmp) rmSync(tmp, { recursive: true, force: true });
  });

  it("fires on `as unknown as` in a production file", async () => {
    const target = join(tmp, "violation.ts");
    writeFileSync(target, "export const x = {} as unknown as { foo: string };\n");

    const { exitCode, output } = await runBiomeLint(target);

    expect(exitCode, `biome should exit non-zero; output:\n${output}`).not.toBe(0);
    expect(output).toMatch(/Avoid `as unknown as`/);
    expect(output).toMatch(/violation\.ts:\d+/);
  });

  it("does NOT fire on `as unknown as` in a *.test.ts file", async () => {
    const target = join(tmp, "violation.test.ts");
    writeFileSync(target, "export const x = {} as unknown as { foo: string };\n");

    const { exitCode, output } = await runBiomeLint(target);

    expect(exitCode, `biome should exit zero on test files; output:\n${output}`).toBe(0);
    expect(output).not.toMatch(/Avoid `as unknown as`/);
  });

  it("respects `// biome-ignore lint/plugin/no-unsafe-cast` suppressions", async () => {
    const target = join(tmp, "suppressed.ts");
    writeFileSync(
      target,
      [
        "// biome-ignore lint/plugin/no-unsafe-cast: smoke-test fixture",
        "export const x = {} as unknown as { foo: string };",
        "",
      ].join("\n"),
    );

    const { exitCode, output } = await runBiomeLint(target);

    expect(exitCode, `suppression should silence the plugin; output:\n${output}`).toBe(0);
  });
});
