/**
 * Zod schema for `evolution_events.payload` — the persisted shape of an
 * Observer fire's `ObserverResult` (status: "processed" only). Validated at
 * the store boundary via `jsonbZod`, so any shape drift between the Observer
 * and the read surface is caught at the column layer.
 *
 * Shape mirrors `ProcessedObserverResult` from `observer.ts` minus the
 * `status` / `conversationId` fields (status is implied by the row existing;
 * conversationId is a top-level column). `messageCount`, `profileId`, and
 * `durationMs` are added so the `/learned` digest and detail views don't
 * need to join back to `messages` / `conversations` to render "from profile
 * X, N turns, took Yms" headers.
 *
 * **Source of truth for the persisted shape lives here.** The runtime
 * interfaces in `extract-corrections.ts` / `extract-memories.ts` /
 * `consolidate-rules.ts` are the *runtime* shapes the Observer steps
 * produce; the schemas here are the *durable* shape. They happen to match
 * today, and the bidirectional `extends` assertions at the bottom of this
 * file fail at compile time if either side drifts. When divergence is
 * intentional (e.g. you don't want a new ExtractionResult field on disk),
 * loosen the schema explicitly and update the assertion rather than
 * silently relying on Zod's default-strip behaviour.
 */

import { z } from "zod";
import type { ConsolidationResult } from "./consolidate-rules.js";
import type { ExtractionResult } from "./extract-corrections.js";
import type { MemoryExtractionResult } from "./extract-memories.js";

export const EvolutionTriggerSchema = z.enum(["idle", "manual"]);
export type EvolutionTrigger = z.infer<typeof EvolutionTriggerSchema>;

const ExtractionResultSchema = z.object({
  extracted: z.number().int().nonnegative(),
  reinforced: z.number().int().nonnegative(),
  contradictions: z.number().int().nonnegative(),
  promoted: z.number().int().nonnegative(),
  outOfScopeReinforcementsSkipped: z.number().int().nonnegative(),
  unknownRuleReinforcementsSkipped: z.number().int().nonnegative(),
  consolidationNeeded: z.boolean(),
});

const ConsolidationResultSchema = z.object({
  mergedGroups: z.number().int().nonnegative(),
  rulesRemoved: z.number().int().nonnegative(),
});

const MemoryExtractionResultSchema = z.object({
  extracted: z.number().int().nonnegative(),
  byNetwork: z.record(z.string(), z.number().int().nonnegative()),
});

const DrainResultSchema = z.object({
  drained: z.number().int().nonnegative(),
  byNetwork: z.record(z.string(), z.number().int().nonnegative()),
});

export const EvolutionEventPayloadSchema = z.object({
  corrections: ExtractionResultSchema,
  consolidation: ConsolidationResultSchema.nullable(),
  memories: MemoryExtractionResultSchema,
  drained: DrainResultSchema,
  messageCount: z.number().int().nonnegative(),
  profileId: z.string().uuid(),
  /**
   * Wall-clock duration of the Observer fire, milliseconds. Stamped by
   * `runObserver` at the end of the fire so the digest detail view can
   * surface "took Ns" to the operator. Optional because pre-feature rows
   * (none today — fresh table) or future divergence would otherwise force
   * a backfill.
   */
  durationMs: z.number().int().nonnegative().optional(),
});
export type EvolutionEventPayload = z.infer<typeof EvolutionEventPayloadSchema>;

// --- Type-level cross-checks ---
//
// Catch silent shape drift between the runtime Result types in the Observer
// steps and the persisted Zod schema above. Zod's `z.object()` strips
// unknown keys on parse, so a new field on `ExtractionResult` would be
// dropped on write with no runtime error and no compile error. The
// bidirectional assertions below fail at compile time in that case — pick
// one direction to fix (extend the schema, or document the deliberate
// omission and `Omit<>` it from the runtime side here).

type _CorrectionsForward =
  ExtractionResult extends z.infer<typeof ExtractionResultSchema> ? true : never;
type _CorrectionsBackward =
  z.infer<typeof ExtractionResultSchema> extends ExtractionResult ? true : never;
const _correctionsForward: _CorrectionsForward = true;
const _correctionsBackward: _CorrectionsBackward = true;

type _ConsolidationForward =
  ConsolidationResult extends z.infer<typeof ConsolidationResultSchema> ? true : never;
type _ConsolidationBackward =
  z.infer<typeof ConsolidationResultSchema> extends ConsolidationResult ? true : never;
const _consolidationForward: _ConsolidationForward = true;
const _consolidationBackward: _ConsolidationBackward = true;

type _MemoriesForward =
  MemoryExtractionResult extends z.infer<typeof MemoryExtractionResultSchema> ? true : never;
type _MemoriesBackward =
  z.infer<typeof MemoryExtractionResultSchema> extends MemoryExtractionResult ? true : never;
const _memoriesForward: _MemoriesForward = true;
const _memoriesBackward: _MemoriesBackward = true;

// Suppress unused-var warnings for the assertion variables — their entire
// purpose is the compile-time type check; runtime references would be
// redundant. Listing each instead of `// biome-ignore` keeps the intent
// visible to readers.
void _correctionsForward;
void _correctionsBackward;
void _consolidationForward;
void _consolidationBackward;
void _memoriesForward;
void _memoriesBackward;
