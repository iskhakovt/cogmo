/**
 * Memory extraction over one turn: the prompt, the call and the parse
 * (design/observation.md → Slice 2a). Classifies each fact into a memory
 * network, compartment and trust tier. Storing and retaining the facts is the
 * turn's use cases' (`observation/observe-turn-memories.ts`).
 */

import type { z } from "zod";
import type { LlmProvider } from "../../llm/provider.js";
import { chatTyped } from "../../llm/typed.js";
import type { MemoryRule } from "../store/index.js";
import { type TurnText, turnMessage } from "./extract-corrections.js";
import {
  type buildExtractedMemorySchema,
  buildMemoryExtractionPrompt,
  buildMemoryExtractionSchema,
  type CompartmentDefinition,
} from "./memory-extraction-schema.js";

export interface MemoryExtractionDeps {
  provider: LlmProvider;
  model: string;
  /**
   * The user's `custom_compartments` rows at fire time. Templated into the
   * extraction prompt and locked into the structured-output schema so the
   * LLM picks exactly from `core ∪ customs`. Empty array = core-only.
   */
  customCompartments: ReadonlyArray<CompartmentDefinition>;
}

/** A fact as the model returns it. */
export type ExtractedMemory = z.infer<ReturnType<typeof buildExtractedMemorySchema>>;

/** What a fire's memories phase did, as the audit row records it. */
export interface MemoryExtractionResult {
  /** Facts retained this fire. */
  extracted: number;
  byNetwork: Record<string, number>;
  /** Turns this fire held for a user's memory rule the profile can't see. */
  skippedForUnseenRules: number;
}

/**
 * Ask the model for one turn's facts, under the `memory`-category rules the
 * fire's profile sees. Provider failures throw, for the caller to classify.
 */
export async function extractTurnMemories(
  text: TurnText,
  memoryRules: ReadonlyArray<MemoryRule>,
  deps: MemoryExtractionDeps,
): Promise<ReadonlyArray<ExtractedMemory>> {
  const { data } = await chatTyped({
    provider: deps.provider,
    model: deps.model,
    system: buildMemoryExtractionPrompt(
      deps.customCompartments,
      memoryRules.map((r) => r.rule),
    ),
    messages: [{ role: "user", content: turnMessage(text) }],
    schema: buildMemoryExtractionSchema(deps.customCompartments.map((c) => c.name)),
    name: "memory-extraction",
    repair: {},
  });
  return data.memories;
}
