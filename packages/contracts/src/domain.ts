/**
 * Domain value-shapes + entity projections shared with the web client.
 * Mirrored from backend `z.infer` shapes (`src/agent/store/schema.ts`) and
 * store/service interfaces; parity is enforced at compile time by
 * `apps/server/src/test/contracts-parity.ts`.
 *
 * `Date` fields stay `Date` (not `string`): oRPC transports `Date` natively,
 * and mirroring the in-process shape keeps the parity guard exact.
 */
import type {
  AutoRecallMode,
  CodingAutoapproveMode,
  EvolutionTriggerValue,
  MemoryCompartment,
  MemoryTrust,
  ScheduleKind,
  VoiceMode,
} from "./enums.js";

export type ToolSet = string[];

export interface CooldownState {
  lastErroredAt: string;
  cooldownSeconds: number;
  consecutiveFailures: number;
}

export interface ProfileMemoryScope {
  compartments: MemoryCompartment[];
  trust: MemoryTrust[];
  // `?: T | undefined` (not `?: T`) to match Zod's `.optional()` inference
  // under exactOptionalPropertyTypes; the parity guard requires exact equality.
  profileClasses?: string[] | undefined;
}

export interface Profile {
  id: string;
  userId: string | null;
  name: string;
  basePrompt: string;
  model: string;
  summarizationModel: string | null;
  extractionModel: string | null;
  autoRecall: AutoRecallMode;
  voiceMode: VoiceMode;
  toolSet: ToolSet;
  memoryScope: ProfileMemoryScope | null;
  profileClass: string | null;
  streamChunkChars: number;
  streamEdits: boolean;
  codingAutoapproveMode: CodingAutoapproveMode;
}

export interface ProfileClass {
  id: string;
  userId: string;
  name: string;
  description: string;
  restricted: boolean;
  createdAt: Date;
}

export interface CustomCompartment {
  id: string;
  userId: string;
  name: string;
  description: string;
  createdAt: Date;
}

export interface ConversationSummary {
  id: string;
  profileName: string;
  alias: string | null;
  lastMessagePreview: string;
  lastMessageAt: Date;
}

/**
 * One past turn for the web chat history read. Lean by design: `text` is the
 * displayable prose of the message (concatenated text blocks). Tool-call cards
 * render live during streaming; reconstructing them from history is deferred to
 * the reconnect-replay work, which pairs tool_use/tool_result across messages.
 */
export interface ChatHistoryMessage {
  id: string;
  role: "user" | "assistant";
  text: string;
}

export interface ScheduledTaskSummary {
  id: string;
  kind: ScheduleKind;
  cron: string | null;
  prompt: string;
  timezone: string;
  nextRunAt: Date;
  lastRunAt: Date | null;
  enabled: boolean;
}

export interface EvolutionEventPayload {
  corrections: {
    extracted: number;
    reinforced: number;
    contradictions: number;
    promoted: number;
    outOfScopeReinforcementsSkipped: number;
    unknownRuleReinforcementsSkipped: number;
    consolidationNeeded: boolean;
  };
  consolidation: { mergedGroups: number; rulesRemoved: number } | null;
  memories: { extracted: number; byNetwork: Record<string, number> };
  drained: { drained: number; byNetwork: Record<string, number> };
  messageCount: number;
  profileId: string;
  durationMs?: number | undefined;
}

export interface EvolutionEventRow {
  id: string;
  conversationId: string;
  userId: string;
  triggeredBy: EvolutionTriggerValue;
  payload: EvolutionEventPayload;
  createdAt: Date;
}
