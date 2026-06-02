/**
 * Closed value-set types shared with the web client. Mirrored from backend
 * `pgEnum`-derived unions and string-enum schemas; the backend keeps the
 * canonical (schema-derived) definitions and the compile-time parity guard in
 * `apps/server/src/test/contracts-parity.ts` fails the build on any drift.
 *
 * `MemoryCompartment` is `string` (not a literal union): the curated core set
 * is extended per-user by custom compartments at runtime, so the schema is a
 * described `string` rather than a closed enum.
 */
export type AutoRecallMode = "off" | "always" | "heuristic" | "llm";
export type VoiceMode = "auto" | "always" | "never";
export type CodingAutoapproveMode = "off" | "on";
export type ScheduleKind = "recurring" | "one_off";
export type SkillTier = "wasm" | "container";
export type SkillRiskTier = "auto" | "notify" | "approve";
export type MemoryTrust = "first-party" | "any";
export type MemoryCompartment = string;
export type EvolutionTriggerValue = "idle" | "manual";
export type McpServerApprovalStatus = "pending" | "approved" | "needs_reapproval";
export type McpTransportKind = "stdio" | "http" | "sse";
