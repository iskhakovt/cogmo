/**
 * What a turn's extraction stored on its `turn_observations` row, written
 * once by `pending → extracted` and never rewritten, so a re-run reads the
 * same items back (design/observation.md → Slice 2a → Storage).
 */

import { z } from "zod";
import {
  MemoryCompartmentSchema,
  MemoryNetworkSchema,
  MemoryTrustSchema,
} from "../memory-extraction-schema.js";

/** One stored fact; its index in `items` is its Hindsight document id's suffix. */
const StoredMemorySchema = z.object({
  fact: z.string().min(1),
  network: MemoryNetworkSchema,
  // Loose: a custom compartment the fact was filed under may be removed later.
  compartment: MemoryCompartmentSchema,
  trust: MemoryTrustSchema,
  context: z.string().min(1).optional(),
  /** The turn's words that state the fact. */
  evidence: z.string().min(1),
});
export type StoredMemory = z.infer<typeof StoredMemorySchema>;

export const TurnExtractionSchema = z.object({
  phase: z.literal("memories"),
  /** The run that extracted it: Inngest's run id, or a fresh uuid per `/reflect`. */
  runId: z.string().min(1),
  /** The profile the extraction ran under, whose class tags every fact. */
  profileId: z.string().uuid(),
  profileClass: z.string().min(1).nullable(),
  /**
   * Whether that profile sees the user's instruction rules, so its prompt
   * listed the user's memory rules: an extraction made without them is held
   * while one of them applies to the profile.
   */
  seesUserRules: z.boolean(),
  items: z.array(StoredMemorySchema),
  dropped: z.object({ noEvidence: z.number().int().nonnegative() }),
});
export type TurnExtraction = z.infer<typeof TurnExtractionSchema>;
