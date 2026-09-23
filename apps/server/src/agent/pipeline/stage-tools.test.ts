import { describe, expect, it } from "vitest";
import { z } from "zod";
import { defineTool, ToolRegistry } from "../tools.js";
import type { PipelineStageContext } from "./load-stage-context.js";
import { buildStageToolRegistry } from "./stage-tools.js";
import type { Stage } from "./types.js";

function tool(name: string) {
  return defineTool({
    name,
    description: name,
    schema: z.object({}),
    handler: async () => "ok",
  });
}

function registryOf(...names: string[]): ToolRegistry {
  const registry = new ToolRegistry();
  for (const name of names) registry.register(tool(name));
  return registry;
}

function contextFor(stage: Stage): PipelineStageContext {
  return {
    runId: "run-1",
    conversationId: "conv-1",
    status: "running",
    userId: "user-1",
    pipelineName: "issue-to-pr",
    definitionVersion: 1,
    stage,
    stageId: stage.id,
    iteration: 0,
    stageIndex: 0,
    stageCount: 2,
    priorStageIds: [],
    nextStageId: "next",
    stageOutputs: {},
  };
}

const agentic = (tools?: string[]): Stage => ({
  id: "gather",
  kind: "agentic",
  instructions: "gather",
  ...(tools !== undefined && { tools }),
});

function names(registry: ToolRegistry): string[] {
  return registry
    .snapshot()
    .map((t) => t.name)
    .sort();
}

describe("buildStageToolRegistry", () => {
  it("narrows the turn's tools to the stage's allowlist and adds the stage's exit", () => {
    const scoped = buildStageToolRegistry(
      registryOf("memory_recall", "web_search", "delegate_coding"),
      contextFor(agentic(["memory_recall", "web_search"])),
    );
    expect(names(scoped)).toEqual(["complete_stage", "memory_recall", "web_search"]);
  });

  it("resolves globs, not just exact names", () => {
    const scoped = buildStageToolRegistry(
      registryOf("mcp__github__list_prs", "mcp__slack__post", "read_file"),
      contextFor(agentic(["mcp__github__*"])),
    );
    expect(names(scoped)).toEqual(["complete_stage", "mcp__github__list_prs"]);
  });

  it("can only narrow — a glob for a tool the profile never composed adds nothing", () => {
    const scoped = buildStageToolRegistry(
      registryOf("read_file"),
      contextFor(agentic(["delegate_coding", "read_file"])),
    );
    expect(names(scoped)).toEqual(["complete_stage", "read_file"]);
  });

  it("leaves the profile's toolset intact for a stage that declares no allowlist", () => {
    const scoped = buildStageToolRegistry(
      registryOf("memory_recall", "read_file"),
      contextFor(agentic()),
    );
    expect(names(scoped)).toEqual(["complete_stage", "memory_recall", "read_file"]);
  });

  it("still lets a stage whose allowlist resolves to nothing finish", () => {
    const scoped = buildStageToolRegistry(
      registryOf("read_file"),
      contextFor(agentic(["nothing_matches_*"])),
    );
    expect(names(scoped)).toEqual(["complete_stage"]);
  });

  it("denies the pipeline-authoring tools whatever the stage declared", () => {
    const scoped = buildStageToolRegistry(
      registryOf("define_pipeline", "activate_pipeline", "start_pipeline", "list_pipelines"),
      contextFor(agentic(["*"])),
    );
    expect(names(scoped)).toEqual(["complete_stage"]);
  });

  it("does not mutate the registry it narrows", () => {
    const turnTools = registryOf("read_file", "define_pipeline");
    buildStageToolRegistry(turnTools, contextFor(agentic(["read_file"])));
    expect(names(turnTools)).toEqual(["define_pipeline", "read_file"]);
  });

  it("keeps its own complete_stage when a tool of that name is already registered", () => {
    const scoped = buildStageToolRegistry(registryOf("complete_stage"), contextFor(agentic(["*"])));
    const exit = scoped.get("complete_stage");
    // The stage's own exit is durable and side-effectful; the decoy is not.
    expect(exit?.durable).toBe(true);
    expect(exit?.sideEffectful).toBe(true);
  });

  it("builds the exit against the stage's cursor", () => {
    const context = { ...contextFor(agentic()), iteration: 3 };
    const scoped = buildStageToolRegistry(registryOf(), context);
    expect(scoped.get("complete_stage")?.description).toContain("gather");
  });
});
