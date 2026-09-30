/**
 * What Anthropic does with a replayed thinking block whose prefix changed —
 * `llm_providers.attrs.prefixMismatchBehavior`, which the Anthropic adapter
 * sends as `thinking.block_binding.prefix_mismatch_behavior` (see
 * design/prompt-caching.md → Server-side controls). `error` rejects the
 * request; `drop_block` drops the failing block and every later one.
 */

import { z } from "zod";

export const PrefixMismatchBehaviorSchema = z.enum(["drop_block", "error"]);
export type PrefixMismatchBehavior = z.infer<typeof PrefixMismatchBehaviorSchema>;
