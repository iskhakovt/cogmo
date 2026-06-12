import { describe, expect, it, vi } from "vitest";
import { type MockProxy, mock } from "vitest-mock-extended";
import type { Transactor } from "../../db/index.js";
import type { LlmProvider } from "../../llm/provider.js";
import { expectDefined } from "../../test/assertions.js";
import { createPipelinesService, type PipelinesServiceDeps } from "./pipelines-service.js";
import type { PipelineDefinitionRow, PipelineStore } from "./store/index.js";
import { FIXTURE_TOOLS, validPipelineDefinition } from "./test-fixtures.js";

const FAKE_TX = { __mockTx: true } as never;
const fakeRunInTx: Transactor = (cb) => cb(FAKE_TX);

function providerReturning(definitions: ReadonlyArray<object>): LlmProvider {
  const chat = vi.fn();
  for (const d of definitions) {
    chat.mockResolvedValueOnce({
      content: [{ type: "text", text: JSON.stringify(d) }],
      stopReason: "end_turn",
      model: "test-model",
      usage: { inputTokens: 10, outputTokens: 5 },
    });
  }
  return { name: "test", chat, chatStream: vi.fn(), countTokens: vi.fn() };
}

function row(overrides: Partial<PipelineDefinitionRow> = {}): PipelineDefinitionRow {
  return {
    id: "row-1",
    userId: "user-1",
    name: "issue-to-pr",
    version: 1,
    sourceText: "source",
    compiled: validPipelineDefinition(),
    active: false,
    createdAt: new Date("2026-06-12T00:00:00Z"),
    ...overrides,
  };
}

function makeDeps(
  overrides: Partial<Omit<PipelinesServiceDeps, "store">> = {},
): PipelinesServiceDeps & { store: MockProxy<PipelineStore> } {
  const store = mock<PipelineStore>();
  store.listDefinitions.mockResolvedValue([]);
  store.insertDefinition.mockResolvedValue(row());
  return {
    runInTx: fakeRunInTx,
    store,
    userId: "user-1",
    resolveProvider: vi.fn().mockResolvedValue({
      provider: providerReturning([validPipelineDefinition()]),
      limits: {},
    }),
    model: "test-model",
    validation: { availableTools: FIXTURE_TOOLS, knownEventSources: [] },
    ...overrides,
  };
}

describe("pipelines service", () => {
  describe("define", () => {
    it("compiles, stores inactive, and returns the preview", async () => {
      const deps = makeDeps();
      const service = createPipelinesService(deps);

      const result = await service.define({ sourceText: "gather context, gate, implement" });

      const ok = expectDefined(result.isOk() ? result.value : undefined, "ok");
      expect(ok.name).toBe("issue-to-pr");
      expect(ok.version).toBe(1);
      expect(ok.preview).toContain("**Pipeline: issue-to-pr**");
      expect(deps.store.insertDefinition).toHaveBeenCalledWith(
        expect.anything(),
        expect.objectContaining({
          userId: "user-1",
          name: "issue-to-pr",
          sourceText: "gather context, gate, implement",
        }),
      );
    });

    it("rejects over-long source text without calling the LLM", async () => {
      const deps = makeDeps();
      const service = createPipelinesService(deps);
      const result = await service.define({ sourceText: "x".repeat(8001) });
      const error = expectDefined(result.isErr() ? result.error : undefined, "err");
      expect(error.kind).toBe("source_too_long");
      expect(deps.resolveProvider).not.toHaveBeenCalled();
    });

    it("returns compile_failed with issues when validation never converges", async () => {
      const bad = validPipelineDefinition();
      const stage = expectDefined(bad.stages[0], "stage");
      stage.tools = ["made_up_tool"];
      const deps = makeDeps({
        resolveProvider: vi.fn().mockResolvedValue({
          provider: providerReturning([bad, bad, bad]),
          limits: {},
        }),
      });
      const service = createPipelinesService(deps);

      const result = await service.define({ sourceText: "gather context, gate, implement" });

      const error = expectDefined(result.isErr() ? result.error : undefined, "err");
      expect(error.kind).toBe("compile_failed");
      expect(deps.store.insertDefinition).not.toHaveBeenCalled();
    });

    it("enforces the definition cap before inserting", async () => {
      const deps = makeDeps({ definitionCap: 1 });
      deps.store.listDefinitions.mockResolvedValue([row()]);
      const service = createPipelinesService(deps);

      const result = await service.define({ sourceText: "gather context, gate, implement" });

      const error = expectDefined(result.isErr() ? result.error : undefined, "err");
      expect(error).toEqual({ kind: "definition_cap_exceeded", limit: 1, current: 1 });
      expect(deps.store.insertDefinition).not.toHaveBeenCalled();
    });
  });

  describe("activate", () => {
    it("activates the latest version by name", async () => {
      const deps = makeDeps();
      deps.store.getDefinitionByName.mockResolvedValue(row({ id: "row-2", version: 2 }));
      deps.store.activateDefinition.mockResolvedValue({
        kind: "activated",
        name: "issue-to-pr",
        version: 2,
      });
      const service = createPipelinesService(deps);

      const result = await service.activate({ name: "issue-to-pr" });

      const ok = expectDefined(result.isOk() ? result.value : undefined, "ok");
      expect(ok).toEqual({ name: "issue-to-pr", version: 2 });
      expect(deps.store.getDefinitionByName).toHaveBeenCalledWith(
        expect.anything(),
        "user-1",
        "issue-to-pr",
        undefined,
      );
    });

    it("returns not_found for an unknown name", async () => {
      const deps = makeDeps();
      deps.store.getDefinitionByName.mockResolvedValue(undefined);
      const service = createPipelinesService(deps);

      const result = await service.activate({ name: "ghost" });

      const error = expectDefined(result.isErr() ? result.error : undefined, "err");
      expect(error).toEqual({ kind: "not_found", name: "ghost" });
    });
  });

  describe("list", () => {
    it("summarizes per name with active + latest versions", async () => {
      const deps = makeDeps();
      deps.store.listDefinitions.mockResolvedValue([
        row({ id: "a2", version: 2, active: false }),
        row({ id: "a1", version: 1, active: true }),
        row({ id: "b1", name: "other", version: 1, active: false }),
      ]);
      const service = createPipelinesService(deps);

      const summaries = await service.list();

      expect(summaries).toEqual([
        expect.objectContaining({ name: "issue-to-pr", latestVersion: 2, activeVersion: 1 }),
        expect.objectContaining({ name: "other", latestVersion: 1, activeVersion: null }),
      ]);
    });
  });
});
