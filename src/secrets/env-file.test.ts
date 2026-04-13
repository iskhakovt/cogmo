import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { resolveEnvFile } from "./env-file.js";

function tempFile(content: string): string {
  const dir = mkdtempSync(join(tmpdir(), "cogmo-test-"));
  const path = join(dir, "secret.txt");
  writeFileSync(path, content);
  return path;
}

describe("resolveEnvFile", () => {
  it("returns env value when _FILE is not set", () => {
    const env = { FOO: "bar" };
    expect(resolveEnvFile(env, "FOO")).toBe("bar");
  });

  it("reads file when _FILE is set", () => {
    const path = tempFile("secret-from-file");
    const env = { FOO_FILE: path };
    expect(resolveEnvFile(env, "FOO")).toBe("secret-from-file");
  });

  it("prefers _FILE over direct value", () => {
    const path = tempFile("from-file");
    const env = { FOO: "from-env", FOO_FILE: path };
    expect(resolveEnvFile(env, "FOO")).toBe("from-file");
  });

  it("trims whitespace from file content", () => {
    const path = tempFile("  secret-with-whitespace\n\n");
    const env = { FOO_FILE: path };
    expect(resolveEnvFile(env, "FOO")).toBe("secret-with-whitespace");
  });

  it("throws on missing file", () => {
    const env = { FOO_FILE: "/nonexistent/path/secret.txt" };
    expect(() => resolveEnvFile(env, "FOO")).toThrow();
  });

  it("returns undefined when neither is set", () => {
    expect(resolveEnvFile({}, "FOO")).toBeUndefined();
  });
});
