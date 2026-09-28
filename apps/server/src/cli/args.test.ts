import { command, flag, runSafely } from "cmd-ts";
import { describe, expect, it } from "vitest";
import { identifier, intAtLeast, optionalOption } from "./args.js";

describe("identifier", () => {
  const name = identifier("name");

  it("passes a name through", async () => {
    await expect(name.from("x-ai/grok-4.3")).resolves.toBe("x-ai/grok-4.3");
  });

  it.each([
    ["", "expected a value, got an empty string"],
    ["--all", 'expected a value, got the flag "--all"'],
    ["-v", 'expected a value, got the flag "-v"'],
  ])("rejects %j", async (value, message) => {
    await expect(name.from(value)).rejects.toThrow(message);
  });
});

describe("intAtLeast", () => {
  it.each([
    [0, "0", 0],
    [1, "200000", 200000],
    [1, " 8000 ", 8000],
  ])("accepts min=%d value %j", async (min, value, expected) => {
    await expect(intAtLeast(min).from(value)).resolves.toBe(expected);
  });

  it.each([
    [1, "0"],
    [0, "-1"],
    [1, "200000abc"],
    [1, "1.5"],
    [1, "not-a-number"],
    [0, ""],
    [0, " "],
    [1, "0x10"],
    [1, "1e3"],
    [1, "+5"],
  ])("rejects min=%d value %j", async (min, value) => {
    await expect(intAtLeast(min).from(value)).rejects.toThrow(
      `expected an integer >= ${min}, got "${value}"`,
    );
  });

  it("accepts Postgres integer's maximum and rejects one past it", async () => {
    await expect(intAtLeast(0).from("2147483647")).resolves.toBe(2147483647);
    await expect(intAtLeast(0).from("2147483648")).rejects.toThrow(
      'expected an integer <= 2147483647, got "2147483648"',
    );
  });
});

describe("optionalOption", () => {
  const cli = command({
    name: "add",
    args: {
      context: optionalOption({
        long: "context",
        type: intAtLeast(1),
        description: "Context window.",
      }),
      all: flag({ long: "all" }),
    },
    handler: async ({ context }) => context,
  });

  async function parse(argv: string[]) {
    const result = await runSafely(cli, argv);
    return result._tag === "ok"
      ? { value: result.value }
      : { error: result.error.config.message, exitCode: result.error.config.exitCode };
  }

  it("resolves to undefined when omitted", async () => {
    expect(await parse(["--all"])).toEqual({ value: undefined });
  });

  it.each([[["--context", "8000"]], [["--context=8000"]]])("decodes %j", async (argv) => {
    expect(await parse(argv)).toEqual({ value: 8000 });
  });

  it("rejects the option given without a value", async () => {
    const parsed = await parse(["--all", "--context"]);

    expect(parsed.value).toBeUndefined();
    expect(parsed.error).toMatch(/--context\n\s+\^ Expected to get a value, found a flag/);
  });

  it("rejects the option given twice", async () => {
    const parsed = await parse(["--context", "1", "--context", "2"]);

    expect(parsed.error).toContain("Too many times provided. Expected 1, got: 2");
  });

  it("reports the value type's decode error", async () => {
    const parsed = await parse(["--context", "0"]);

    expect(parsed.error).toContain('expected an integer >= 1, got "0"');
  });

  it("shows as optional in help, with the type's display name", async () => {
    const parsed = await parse(["--help"]);

    expect(parsed.exitCode).toBe(0);
    expect(parsed.error).toMatch(/--context <int> +- Context window\. \[optional\]/);
  });
});
