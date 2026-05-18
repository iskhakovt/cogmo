/**
 * Zod schema for `evolution_events.payload` — the persisted shape of an
 * Observer fire's `ObserverResult` (status: "processed" only). Validated at
 * the store boundary via `jsonbZod`, so any shape drift between the Observer
 * and the read surface is caught at the column layer.
 *
 * Shape mirrors `ProcessedObserverResult` from `observer.ts` minus the
 * `status` / `conversationId` fields (status is implied by the row existing;
 * conversationId is a top-level column). `messageCount` and `profileId` are
 * added so the `/learned` digest and detail views don't need to join back to
 * `messages` / `conversations` to render "from profile X, N turns" headers.
 *
 * Schemas here are deliberately self-contained — they don't import from
 * `extract-corrections.ts` / `extract-memories.ts` / `consolidate-rules.ts`
 * to keep the persisted shape's source of truth here at the store boundary.
 * The interfaces in those files are the *runtime* shape produced by each
 * step; the schemas here are the *durable* shape. They happen to match
 * today; treat divergence as intentional (e.g. dropping a field from
 * persistence) rather than a bug to reconcile.
 */

import { z } from "zod";

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
});
export type EvolutionEventPayload = z.infer<typeof EvolutionEventPayloadSchema>;
