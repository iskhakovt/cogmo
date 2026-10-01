/**
 * Memory extraction — pure function with injected dependencies.
 *
 * Analyzes a conversation transcript for facts worth remembering,
 * classifies each into a memory network, and retains them to Hindsight
 * with network tags and per-tag observation scoping.
 */

import * as R from "remeda";
import type { z } from "zod";
import type { LlmProvider } from "../../llm/provider.js";
import { chatTyped } from "../../llm/typed.js";
import type { Message } from "../../llm/types.js";
import { logger } from "../../logger.js";
import type { MemoryProvider, RetainBatchItem } from "../../memory/provider.js";
import { bindsUnseenUserRule, type MemoryRule } from "../store/index.js";
import type { ObserverFire } from "./drain-pending-memories.js";
import { formatTranscript } from "./extract-corrections.js";
import {
  buildMemoryExtractionPrompt,
  buildMemoryExtractionSchema,
  type CompartmentDefinition,
} from "./memory-extraction-schema.js";

export interface MemoryExtractionDeps {
  provider: LlmProvider;
  model: string;
  memory: Pick<MemoryProvider, "retainBatch">;
  /**
   * The user's `custom_compartments` rows at fire time. Templated into the
   * extraction prompt and locked into the structured-output schema so the
   * LLM picks exactly from `core ∪ customs`. Empty array = core-only.
   */
  customCompartments: ReadonlyArray<CompartmentDefinition>;
  /** The live `memory`-category rules the conversation's profile sees; extraction stores nothing one forbids. */
  memoryRules: ReadonlyArray<MemoryRule>;
  /**
   * The fire this extraction runs in. When its profile doesn't see the
   * user's rules and one of the user's memory rules binds the transcript,
   * extraction is skipped rather than store what that rule may forbid.
   */
  fire: ObserverFire;
}

export interface MemoryExtractionResult {
  extracted: number;
  byNetwork: Record<string, number>;
  /** 1 when extraction was skipped for a user's memory rule the profile can't see, else 0. */
  skippedForUnseenRules: number;
}

function nothingExtracted(skippedForUnseenRules: number): MemoryExtractionResult {
  return { extracted: 0, byNetwork: {}, skippedForUnseenRules };
}

/**
 * Extract facts from a conversation transcript and retain them to memory.
 *
 * Returns counts of what was extracted. Pure function — all I/O goes through deps.
 *
 * `profileClass` is the conversation's active profile's `profile_class`
 * value (or `null` if unclassed). When non-null it's emitted as a
 * `profile_class:<class>` tag on every retained memory, which the recall
 * filter uses for speaker-driven isolation.
 */
export async function extractMemories(
  history: ReadonlyArray<Message>,
  bankId: string,
  profileClass: string | null,
  deps: MemoryExtractionDeps,
): Promise<MemoryExtractionResult> {
  const transcript = formatTranscript(history);

  if (transcript.trim().length === 0) {
    logger.debug("empty transcript — skipping memory extraction");
    return nothingExtracted(0);
  }

  if (bindsUnseenUserRule(deps.memoryRules, deps.fire.seesUserRules)) {
    logger.info(
      { ...deps.fire },
      "memory extraction skipped — a user's memory rule binds a profile that can't see it",
    );
    return nothingExtracted(1);
  }

  const customNames = deps.customCompartments.map((c) => c.name);
  const schema = buildMemoryExtractionSchema(customNames);
  let data: z.infer<typeof schema>;
  try {
    ({ data } = await chatTyped({
      provider: deps.provider,
      model: deps.model,
      system: buildMemoryExtractionPrompt(
        deps.customCompartments,
        deps.memoryRules.map((r) => r.rule),
      ),
      messages: [{ role: "user", content: transcript }],
      schema,
      name: "memory-extraction",
      repair: {},
    }));
  } catch (err) {
    logger.warn({ err, bankId }, "memory extraction failed — skipping");
    return nothingExtracted(0);
  }

  if (data.memories.length === 0) {
    logger.debug("no memories extracted from transcript");
    return nothingExtracted(0);
  }

  const items: RetainBatchItem[] = data.memories.map((mem) => ({
    content: mem.fact,
    ...(mem.context !== undefined && { context: mem.context }),
    tags: [
      `network:${mem.network}`,
      `compartment:${mem.compartment}`,
      `trust:${mem.trust}`,
      // typeof guard not just `!== null` — Inngest's step memoization
      // can replay this function with a stale arg shape across rolling
      // deploys, where a missing `profileClass` deserializes as
      // `undefined` and `undefined !== null` would emit
      // `profile_class:undefined`.
      ...(typeof profileClass === "string" ? [`profile_class:${profileClass}`] : []),
    ],
    metadata: { source: "conversation" },
    observationScopes: "per_tag" as const,
  }));

  await deps.memory.retainBatch(bankId, items);

  const byNetwork = R.countBy(data.memories, (m) => m.network);

  logger.info({ extracted: data.memories.length, byNetwork, bankId }, "memory extraction complete");

  return { extracted: data.memories.length, byNetwork, skippedForUnseenRules: 0 };
}
