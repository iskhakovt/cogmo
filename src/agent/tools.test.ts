import { describe, expect, it } from "vitest";
import { z } from "zod";
import { memoryTools } from "./memory-tools.js";
import type { Service } from "./service.js";
import { createDefaultTools, defineTool, ToolRegistry } from "./tools.js";

const stubService: Service = {
  memory: {
    recall: async () => ({ memories: [] }),
    retain: async () => {},
  },
  files: {
    read: async () => "",
    write: async () => {},
    list: async () => [],
  },
};

describe("ToolRegistry", () => {
  it("registers and retrieves a tool", () => {
    const registry = new ToolRegistry();
    const spec = defineTool({
      name: "my_tool",
      description: "does stuff",
      schema: z.object({}),
      handler: async () => "result",
    });

    registry.register(spec);

    const retrieved = registry.get("my_tool");
    expect(retrieved).toBeDefined();
    expect(retrieved?.name).toBe("my_tool");
    expect(retrieved?.description).toBe("does stuff");
  });

  it("returns undefined for unknown tool", () => {
    const registry = new ToolRegistry();
    expect(registry.get("nope")).toBeUndefined();
  });

  it("returns all definitions", () => {
    const registry = new ToolRegistry();
    registry.register(
      defineTool({
        name: "a",
        description: "tool a",
        schema: z.object({}),
        handler: async () => "",
      }),
    );
    registry.register(
      defineTool({
        name: "b",
        description: "tool b",
        schema: z.object({ x: z.string() }),
        handler: async () => "",
      }),
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

describe("defineTool", () => {
  it("generates inputSchema from Zod schema", () => {
    const spec = defineTool({
      name: "test",
      description: "test tool",
      schema: z.object({ query: z.string() }),
      handler: async () => "ok",
    });

    expect(spec.inputSchema.type).toBe("object");
    expect(spec.inputSchema.properties).toHaveProperty("query");
    expect(spec.inputSchema.required).toContain("query");
  });

  it("validates input at runtime", async () => {
    const spec = defineTool({
      name: "test",
      description: "test tool",
      schema: z.object({ query: z.string() }),
      handler: async () => "ok",
    });

    // Invalid input — missing required field
    await expect(spec.handler({}, stubService)).rejects.toThrow();
  });

  it("passes parsed typed input to handler", async () => {
    const spec = defineTool({
      name: "test",
      description: "test tool",
      schema: z.object({ query: z.string(), count: z.number().optional() }),
      handler: async (input) => `got: ${input.query}`,
    });

    const result = await spec.handler({ query: "hello" }, stubService);
    expect(result).toBe("got: hello");
  });

  it("passes service to handler", async () => {
    let received: Service | undefined;
    const spec = defineTool({
      name: "test",
      description: "test",
      schema: z.object({}),
      handler: async (_input, caps) => {
        received = caps;
        return "ok";
      },
    });

    await spec.handler({}, stubService);
    expect(received).toBe(stubService);
  });
});

describe("createDefaultTools", () => {
  it("get_current_time returns structured time JSON", async () => {
    const registry = createDefaultTools();
    const spec = registry.get("get_current_time");
    expect(spec).toBeDefined();
    const result = await spec!.handler({}, stubService);
    const parsed = JSON.parse(result);

    expect(parsed.iso).toMatch(/^\d{4}-\d{2}-\d{2}T/);
    expect(parsed.dayOfWeek).toBeTruthy();
    expect(parsed.timezone).toBe("UTC");
    expect(parsed.utcOffset).toBe("UTC+0");
    expect(parsed.date).toMatch(/\w+, \w+ \d+, \d{4}/);
    expect(parsed.time).toMatch(/^\d{2}:\d{2}$/);
  });

  it("get_current_time respects timezone parameter", async () => {
    const registry = createDefaultTools([], "America/New_York");
    const spec = registry.get("get_current_time");
    const result = await spec!.handler({}, stubService);
    const parsed = JSON.parse(result);

    expect(parsed.timezone).toBe("America/New_York");
  });

  it("accepts extra tools", () => {
    const registry = createDefaultTools(memoryTools);
    expect(registry.get("memory_recall")).toBeDefined();
    expect(registry.get("memory_retain")).toBeDefined();
    expect(registry.definitions()).toHaveLength(3);
  });
});
