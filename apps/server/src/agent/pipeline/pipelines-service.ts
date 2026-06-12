/**
 * Pipelines namespace on the per-turn `Service` — the `define_pipeline` /
 * `activate_pipeline` / `list_pipelines` tool surface.
 *
 * Per-conversation scope: userId is baked in at factory time, mirroring
 * the scheduling namespace. Definitions insert inactive; activation is a
 * separate explicit call after the user confirms the preview in chat —
 * that two-step IS the confirmation gate for slice 1
 * (design/pipelines.md → Definition Lifecycle).
 */

import { err, ok, type Result } from "neverthrow";
import type { Transactor } from "../../db/index.js";
import type { LlmProviderResolver } from "../../llm/resolver.js";
import { logger } from "../../logger.js";
import { type CompileError, compilePipeline } from "./compile.js";
import { renderPipelinePreview } from "./preview.js";
import type { PipelineDefinitionRow, PipelineStore } from "./store/index.js";
import type { Trigger } from "./types.js";
import type { ValidationContext } from "./validate.js";

const log = logger.child({ component: "pipeline.service" });

/** Per-user cap on definition rows (all names, all versions). Backstop against a define loop. */
export const DEFAULT_PIPELINE_DEFINITION_CAP = 500;

/** Bound on the free text a definition compiles from — also the compiler's input budget. */
export const MAX_SOURCE_TEXT_LENGTH = 8000;

export type PipelinesError =
  | { kind: "compile_failed"; issues: ReadonlyArray<{ path: string; message: string }> }
  | { kind: "source_too_long"; length: number; maxLength: number }
  | { kind: "definition_cap_exceeded"; limit: number; current: number }
  | { kind: "not_found"; name: string; version?: number };

export interface DefinePipelineResult {
  id: string;
  name: string;
  version: number;
  /** Markdown preview — show the user verbatim; activation requires their explicit confirmation. */
  preview: string;
}

export interface PipelineSummary {
  name: string;
  latestVersion: number;
  activeVersion: number | null;
  trigger: Trigger;
  stageCount: number;
}

export interface PipelinesService {
  /**
   * Compile free text into a definition and store it as a new inactive
   * version. Returns the preview to confirm; nothing runs until
   * {@link activate}.
   */
  define(args: { sourceText: string }): Promise<Result<DefinePipelineResult, PipelinesError>>;

  /** Activate a named definition — latest version unless `version` is given. */
  activate(args: {
    name: string;
    version?: number;
  }): Promise<Result<{ name: string; version: number }, PipelinesError>>;

  /** One summary per pipeline name, with active + latest version. */
  list(): Promise<ReadonlyArray<PipelineSummary>>;
}

export interface PipelinesServiceDeps {
  runInTx: Transactor;
  store: PipelineStore;
  userId: string;
  /** Per-turn provider lookup — the compiler runs on the conversation's current model. */
  resolveProvider: LlmProviderResolver;
  model: string;
  validation: ValidationContext;
  definitionCap?: number;
}

export function createPipelinesService(deps: PipelinesServiceDeps): PipelinesService {
  const definitionCap = deps.definitionCap ?? DEFAULT_PIPELINE_DEFINITION_CAP;

  return {
    async define(args) {
      if (args.sourceText.length > MAX_SOURCE_TEXT_LENGTH) {
        return err({
          kind: "source_too_long" as const,
          length: args.sourceText.length,
          maxLength: MAX_SOURCE_TEXT_LENGTH,
        });
      }

      // Cheap cap pre-check before the billable compile — a capped user
      // shouldn't burn an LLM call to learn they're capped. The in-tx
      // check below stays authoritative (this read is racy by design).
      const precheckCount = await deps.runInTx(
        async (tx) => (await deps.store.listDefinitions(tx, deps.userId)).length,
      );
      if (precheckCount >= definitionCap) {
        return err({
          kind: "definition_cap_exceeded" as const,
          limit: definitionCap,
          current: precheckCount,
        });
      }

      const { provider } = await deps.resolveProvider(deps.model);
      const compiled = await compilePipeline(
        { provider, model: deps.model, validation: deps.validation },
        { sourceText: args.sourceText },
      );
      if (compiled.isErr()) {
        return err(toCompileFailed(compiled.error));
      }
      const { definition } = compiled.value;

      // Cap check + insert in one tx. Same predicate-race caveat as the
      // scheduling cap: REPEATABLE READ doesn't predicate-lock, two
      // concurrent defines can exceed the cap by one — benign at this
      // scale (see .claude/rules/store-pattern.md).
      const result = await deps.runInTx(async (tx) => {
        const existing = await deps.store.listDefinitions(tx, deps.userId);
        if (existing.length >= definitionCap) {
          return err({
            kind: "definition_cap_exceeded" as const,
            limit: definitionCap,
            current: existing.length,
          });
        }
        const row = await deps.store.insertDefinition(tx, {
          userId: deps.userId,
          name: definition.name,
          sourceText: args.sourceText,
          compiled: definition,
        });
        return ok(row);
      });
      if (result.isErr()) return err(result.error);

      const row = result.value;
      log.info(
        { definitionId: row.id, name: row.name, version: row.version, userId: deps.userId },
        "pipeline definition compiled and stored (inactive)",
      );
      return ok({
        id: row.id,
        name: row.name,
        version: row.version,
        preview: renderPipelinePreview(row.compiled),
      });
    },

    async activate(args) {
      return await deps.runInTx(async (tx) => {
        const row = await deps.store.getDefinitionByName(tx, deps.userId, args.name, args.version);
        if (!row) {
          return err({
            kind: "not_found" as const,
            name: args.name,
            ...(args.version !== undefined && { version: args.version }),
          });
        }
        const outcome = await deps.store.activateDefinition(tx, deps.userId, row.id);
        if (outcome.kind === "not_found") {
          return err({ kind: "not_found" as const, name: args.name });
        }
        log.info(
          {
            name: outcome.name,
            version: outcome.version,
            userId: deps.userId,
            outcome: outcome.kind,
          },
          "pipeline definition activation",
        );
        return ok({ name: outcome.name, version: outcome.version });
      });
    },

    async list() {
      const rows = await deps.runInTx((tx) => deps.store.listDefinitions(tx, deps.userId));
      return summarize(rows);
    },
  };
}

function toCompileFailed(error: CompileError): PipelinesError {
  return { kind: "compile_failed", issues: error.issues };
}

function summarize(rows: readonly PipelineDefinitionRow[]): PipelineSummary[] {
  const byName = new Map<string, PipelineDefinitionRow[]>();
  for (const row of rows) {
    const group = byName.get(row.name);
    if (group) group.push(row);
    else byName.set(row.name, [row]);
  }
  return [...byName.entries()].flatMap(([name, group]) => {
    // listDefinitions orders version DESC within a name, so group[0] is
    // latest; groups are built non-empty, the guard narrows without a cast.
    const latest = group[0];
    if (latest === undefined) return [];
    const active = group.find((r) => r.active);
    return [
      {
        name,
        latestVersion: latest.version,
        activeVersion: active?.version ?? null,
        trigger: latest.compiled.trigger,
        stageCount: latest.compiled.stages.length,
      },
    ];
  });
}
