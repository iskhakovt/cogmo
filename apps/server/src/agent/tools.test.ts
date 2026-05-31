import { describe, expect, it } from "vitest";
import { mock } from "vitest-mock-extended";
import { z } from "zod";
import { expectDefined } from "../test/assertions.js";
import { coreMemoryRead } from "./core-memory-tools.js";
import { listFiles, readFile } from "./file-tools.js";
import { memoryRecall, memoryReflect, memoryTools } from "./memory-tools.js";
import { listTasks } from "./scheduling/tools.js";
import type { Service } from "./service.js";
import { createDefaultTools, defineTool, ToolRegistry, type ToolSpec } from "./tools.js";
import { createWebTools } from "./web-tools.js";

// These tests don't read from Service — `mock<Service>()` gives a typed
// proxy where every method is a vi.fn() returning undefined. Drop the
// optional sub-namespaces so an accidental call surfaces as an error.
const stubService: Service = (() => {
  const svc = mock<Service>();
  delete svc.coding;
  delete svc.skills;
  return svc;
})();

const TimeResultSchema = z.object({
  iso: z.string(),
  dayOfWeek: z.string(),
  timezone: z.string(),
  utcOffset: z.string(),
  date: z.string(),
  time: z.string(),
});

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

  // invocationBudget < 1 / non-integer values silently fall into
  // pathological intercept-everything behavior (`classifyVolumeCluster(1, 0)`
  // intercepts the first call). Reject at registration so a typo can't
  // ship a tool that's effectively disabled. The default (5) and
  // explicit positive integers stay accepted unchanged.
  it("rejects invocationBudget < 1", () => {
    expect(() =>
      defineTool({
        name: "bad_zero",
        description: "x",
        schema: z.object({}),
        invocationBudget: 0,
        handler: async () => "ok",
      }),
    ).toThrow(/invocationBudget must be a positive integer/);
  });

  it("rejects negative invocationBudget", () => {
    expect(() =>
      defineTool({
        name: "bad_negative",
        description: "x",
        schema: z.object({}),
        invocationBudget: -1,
        handler: async () => "ok",
      }),
    ).toThrow(/invocationBudget must be a positive integer/);
  });

  it("rejects non-integer invocationBudget", () => {
    expect(() =>
      defineTool({
        name: "bad_float",
        description: "x",
        schema: z.object({}),
        invocationBudget: 2.5,
        handler: async () => "ok",
      }),
    ).toThrow(/invocationBudget must be a positive integer/);
  });

  it("accepts positive integer invocationBudget", () => {
    expect(() =>
      defineTool({
        name: "ok_one",
        description: "x",
        schema: z.object({}),
        invocationBudget: 1,
        handler: async () => "ok",
      }),
    ).not.toThrow();
  });

  it("accepts omitted invocationBudget (default at consumer)", () => {
    const spec = defineTool({
      name: "no_budget",
      description: "x",
      schema: z.object({}),
      handler: async () => "ok",
    });
    expect(spec.invocationBudget).toBeUndefined();
  });
});

describe("ToolSpec.sideEffectful", () => {
  // Type-level: accept true, false, and omit.
  it("accepts sideEffectful: true, false, and omitted", () => {
    const explicitFalse = defineTool({
      name: "explicit_false",
      description: "",
      schema: z.object({}),
      handler: async () => "",
      sideEffectful: false,
    });
    const explicitTrue = defineTool({
      name: "explicit_true",
      description: "",
      schema: z.object({}),
      handler: async () => "",
      sideEffectful: true,
    });
    const omitted = defineTool({
      name: "omitted",
      description: "",
      schema: z.object({}),
      handler: async () => "",
    });

    // `satisfies` keeps the literal types so the assertions below are
    // exact rather than widened to `boolean | undefined`.
    expect(explicitFalse.sideEffectful).toBe(false);
    expect(explicitTrue.sideEffectful).toBe(true);
    expect(omitted.sideEffectful).toBeUndefined();

    // Type-level proof that the field is optional and accepts both bool literals.
    const _a = { ...explicitFalse } satisfies ToolSpec;
    const _b = { ...explicitTrue } satisfies ToolSpec;
    const _c = { ...omitted } satisfies ToolSpec;
    expect(_a.name).toBe("explicit_false");
    expect(_b.name).toBe("explicit_true");
    expect(_c.name).toBe("omitted");
  });

  // Registry-level: tools the design enumerates as read-only must opt out.
  // If a tool drifts away from `sideEffectful: false` (or is renamed) this
  // test fails — Class D's progress gate (PR 6) would silently regress.
  it("marks the documented read-only tools as sideEffectful: false", () => {
    const webTools = createWebTools("tavily-key", "openrouter-key");
    const webByName = new Map(webTools.map((t) => [t.name, t]));
    const defaults = createDefaultTools();

    const readOnlyTools: ReadonlyArray<{ name: string; spec: ToolSpec | undefined }> = [
      { name: "read_file", spec: readFile },
      { name: "list_files", spec: listFiles },
      { name: "memory_recall", spec: memoryRecall },
      { name: "memory_reflect", spec: memoryReflect },
      { name: "core_memory_read", spec: coreMemoryRead },
      { name: "list_tasks", spec: listTasks },
      { name: "get_current_time", spec: defaults.get("get_current_time") },
      { name: "web_search", spec: webByName.get("web_search") },
      { name: "web_answer", spec: webByName.get("web_answer") },
      { name: "fetch_url", spec: webByName.get("fetch_url") },
    ];

    for (const { name, spec } of readOnlyTools) {
      const resolved = expectDefined(spec, name);
      expect(resolved.sideEffectful, `${name} must declare sideEffectful: false`).toBe(false);
    }
  });
});

describe("createDefaultTools", () => {
  it("get_current_time returns structured time JSON", async () => {
    const registry = createDefaultTools();
    const spec = registry.get("get_current_time");
    expect(spec).toBeDefined();
    const result = await spec!.handler({}, stubService);
    const parsed = TimeResultSchema.parse(JSON.parse(result));

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
    const parsed = TimeResultSchema.parse(JSON.parse(result));

    expect(parsed.timezone).toBe("America/New_York");
  });

  it("accepts extra tools", () => {
    const registry = createDefaultTools(memoryTools);
    expect(registry.get("memory_recall")).toBeDefined();
    expect(registry.get("memory_retain")).toBeDefined();
    expect(registry.get("memory_reflect")).toBeDefined();
    expect(registry.definitions()).toHaveLength(4);
  });
});
