import { describe, expect, it } from "vitest";
import { z } from "zod";
import { defineTool, ToolRegistry } from "../tools.js";
import { restrictToStage } from "./stage-tools.js";

function registryOf(...names: string[]): ToolRegistry {
  const registry = new ToolRegistry();
  for (const name of names) {
    registry.register(
      defineTool({
        name,
        description: name,
        schema: z.object({}),
        handler: async () => "ok",
      }),
    );
  }
  return registry;
}

const names = (registry: ToolRegistry) => registry.snapshot().map((t) => t.name);

describe("restrictToStage", () => {
  it("keeps every profile tool except the pipeline tools when the stage declares no allowlist", () => {
    const profileTools = registryOf(
      "memory_recall",
      "web_search",
      "start_pipeline",
      "define_pipeline",
    );
    expect(names(restrictToStage(profileTools, undefined))).toEqual([
      "memory_recall",
      "web_search",
    ]);
  });

  it("narrows to the stage's exact names and globs", () => {
    const profileTools = registryOf("memory_recall", "memory_retain", "web_search", "read_file");
    expect(names(restrictToStage(profileTools, ["memory_*", "read_file"]))).toEqual([
      "memory_recall",
      "memory_retain",
      "read_file",
    ]);
  });

  it("drops pipeline tools even when the allowlist names them", () => {
    const profileTools = registryOf("start_pipeline", "activate_pipeline", "web_search");
    expect(names(restrictToStage(profileTools, ["*_pipeline", "web_search"]))).toEqual([
      "web_search",
    ]);
  });

  it("cannot widen past the profile — an allowlisted tool the profile lacks stays absent", () => {
    const profileTools = registryOf("web_search");
    expect(names(restrictToStage(profileTools, ["web_search", "delegate_coding"]))).toEqual([
      "web_search",
    ]);
  });

  it("returns a fresh registry without mutating the input", () => {
    const profileTools = registryOf("web_search", "read_file");
    restrictToStage(profileTools, ["web_search"]);
    expect(names(profileTools)).toEqual(["web_search", "read_file"]);
  });
});
