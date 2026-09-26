import { describe, expect, it, vi } from "vitest";
import { mock } from "vitest-mock-extended";
import { z } from "zod";
import { expectDefined } from "../test/assertions.js";
import type { Service } from "./service.js";
import { defineTool, ToolRegistry, type ToolSpec } from "./tools.js";
import { bindFrozenTools, freezeToolTable } from "./turn-tools.js";

const service = mock<Service>();

function registryOf(...specs: ToolSpec[]): ToolRegistry {
  const registry = new ToolRegistry();
  for (const spec of specs) registry.register(spec);
  return registry;
}

const generateImage = defineTool({
  name: "generate_image",
  description: "Generate an image",
  schema: z.object({ prompt: z.string(), model: z.string().optional() }),
  durable: true,
  parallelSafe: true,
  sideEffectful: true,
  invocationBudget: 2,
  handler: async ({ prompt }) => `image of ${prompt}`,
});

const echo: ToolSpec = {
  name: "echo",
  description: "echo a number",
  inputSchema: { type: "object", properties: { n: { type: "number" } } },
  durable: true,
  handler: async (input) => `echoed ${JSON.stringify(input)}`,
};

describe("freezeToolTable", () => {
  it("keeps each spec's definition and dispatch policy as JSON text, and nothing callable", () => {
    const table = freezeToolTable(registryOf(generateImage, echo));

    expect(JSON.parse(table)).toEqual([
      {
        name: "generate_image",
        description: "Generate an image",
        inputSchema: generateImage.inputSchema,
        durable: true,
        parallelSafe: true,
        sideEffectful: true,
        invocationBudget: 2,
      },
      {
        name: "echo",
        description: "echo a number",
        inputSchema: echo.inputSchema,
        durable: true,
      },
    ]);
  });
});

describe("bindFrozenTools", () => {
  it("serializes the same definitions, byte for byte, as the registry it froze", () => {
    const live = registryOf(generateImage, echo);

    const bound = bindFrozenTools(freezeToolTable(live), live);

    expect(JSON.stringify(bound.definitions())).toBe(JSON.stringify(live.definitions()));
  });

  it("rejects a table that isn't a list of frozen specs", () => {
    const live = registryOf(echo);

    expect(() => bindFrozenTools(JSON.stringify([{ name: "echo" }]), live)).toThrow();
    expect(() => bindFrozenTools(JSON.stringify({ tools: [] }), live)).toThrow();
  });

  it("offers exactly the frozen definitions, in frozen order", () => {
    const frozen = freezeToolTable(registryOf(generateImage, echo));
    // A later invocation's live build: reordered, one description edited,
    // and a tool the turn never offered.
    const extra = { ...echo, name: "extra" };
    const live = registryOf({ ...echo, description: "echo, reworded" }, generateImage, extra);

    const bound = bindFrozenTools(frozen, live);

    expect(bound.definitions()).toEqual(registryOf(generateImage, echo).definitions());
    expect(bound.get("extra")).toBeUndefined();
  });

  it("dispatches to the live handler and its input normalizer", async () => {
    const frozen = freezeToolTable(registryOf(generateImage));

    const bound = expectDefined(
      bindFrozenTools(frozen, registryOf(generateImage)).get("generate_image"),
      "bound generate_image",
    );

    await expect(bound.handler({ prompt: "a cat" }, service)).resolves.toBe("image of a cat");
    expect(bound.normalizeInput).toBe(generateImage.normalizeInput);
  });

  it("keeps a tool that didn't load this invocation, with a handler that reports it", async () => {
    const frozen = freezeToolTable(registryOf(generateImage, echo));
    const liveHandler = vi.fn();

    const bound = bindFrozenTools(frozen, registryOf({ ...generateImage, handler: liveHandler }));

    const missing = expectDefined(bound.get("echo"), "bound echo");
    // Still offered, and still durable, so a call whose step already ran
    // replays its result instead of reaching the handler.
    expect(bound.definitions().map((d) => d.name)).toEqual(["generate_image", "echo"]);
    expect(missing.durable).toBe(true);
    await expect(missing.handler({ n: 1 }, service)).rejects.toThrow(
      "the echo tool could not be loaded, so it did not run",
    );
    expect(liveHandler).not.toHaveBeenCalled();
  });

  it("takes the dispatch policy from the frozen table", () => {
    const frozen = freezeToolTable(registryOf(generateImage));
    const drifted = { ...generateImage, invocationBudget: 9, parallelSafe: false };

    const bound = expectDefined(
      bindFrozenTools(frozen, registryOf(drifted)).get("generate_image"),
      "bound generate_image",
    );

    expect(bound.invocationBudget).toBe(2);
    expect(bound.parallelSafe).toBe(true);
    expect(bound.handler).toBe(drifted.handler);
  });
});
