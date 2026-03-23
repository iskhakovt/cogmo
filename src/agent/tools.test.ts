import { describe, expect, it } from "vitest";
import { createDefaultTools, ToolRegistry } from "./tools.js";

describe("ToolRegistry", () => {
  it("registers and retrieves a tool", () => {
    const registry = new ToolRegistry();
    const handler = async () => "result";

    registry.register("my_tool", "does stuff", { type: "object" }, handler);

    const spec = registry.get("my_tool");
    expect(spec).toBeDefined();
    expect(spec?.definition.name).toBe("my_tool");
    expect(spec?.definition.description).toBe("does stuff");
    expect(spec?.handler).toBe(handler);
  });

  it("returns undefined for unknown tool", () => {
    const registry = new ToolRegistry();
    expect(registry.get("nope")).toBeUndefined();
  });

  it("returns all definitions", () => {
    const registry = new ToolRegistry();
    registry.register("a", "tool a", { type: "object" }, async () => "");
    registry.register(
      "b",
      "tool b",
      { type: "object", properties: { x: { type: "string" } } },
      async () => "",
    );

    const defs = registry.definitions();
    expect(defs).toHaveLength(2);
    expect(defs.map((d) => d.name)).toEqual(["a", "b"]);
  });

  it("returns empty definitions for empty registry", () => {
    const registry = new ToolRegistry();
    expect(registry.definitions()).toEqual([]);
  });
});

describe("createDefaultTools", () => {
  it("get_current_time returns ISO date string", async () => {
    const registry = createDefaultTools();
    const spec = registry.get("get_current_time");
    expect(spec).toBeDefined();
    const result = await spec!.handler({});

    expect(() => new Date(result)).not.toThrow();
    expect(result).toMatch(/^\d{4}-\d{2}-\d{2}T/);
  });
});
