/**
 * Compile-time parity guard between the backend types (the schema-derived
 * source of truth) and their `@cogmo/contracts` mirrors (consumed by the web
 * client). Each `assertParity` call fails `pnpm typecheck` if a mirror drifts
 * from its backend type in either direction — so the two can never silently
 * desync. Same bidirectional-`extends` pattern as `event-schema.ts`.
 *
 * This module has no runtime effect; it exists solely to be type-checked.
 */
import type * as C from "@cogmo/contracts";
import type { EvolutionEventPayload } from "../agent/evolution/event-schema.js";
import type { MemoryTrust } from "../agent/evolution/memory-extraction-schema.js";
import type { AutoRecallMode } from "../agent/recall-gate.js";
import type { ScheduledTaskSummary } from "../agent/scheduling/scheduling-service.js";
import type {
  ChatHistoryMessage,
  CodingAutoapproveMode,
  ConversationSummary,
  CustomCompartment,
  EvolutionEventRow,
  Profile,
  ProfileClass,
  ScheduleKind,
  VoiceMode,
} from "../agent/store/index.js";
import type {
  CooldownState,
  EvolutionTriggerValue,
  ProfileMemoryScope,
  ToolSet,
} from "../agent/store/schema.js";
import type { StreamEvent } from "../llm/types.js";
import type { SkillRiskTier, SkillTier } from "../skills/store/index.js";
import type {
  ConversationStatusSummary,
  CurrentConversation,
  EvolutionEventEntry,
  ProfileInput,
  RepoCloneAndAddInput,
  RepoInput,
  RepoSummary,
  ScheduledTaskAdminEntry,
  SkillListEntry,
  TransportError,
  TriggerReflectionOutcome,
} from "../transport/transport.js";

/** `true` only when A and B are mutually assignable (structurally equal). */
type Mutual<A, B> = [A] extends [B] ? ([B] extends [A] ? true : false) : false;

/** Fails to type-check when the witness is not exactly `true`. */
function assertParity<_T extends true>(): void {}

// --- stream + errors ---
assertParity<Mutual<StreamEvent, C.StreamEvent>>();
assertParity<Mutual<TransportError, C.TransportError>>();

// --- enums / closed value sets ---
assertParity<Mutual<AutoRecallMode, C.AutoRecallMode>>();
assertParity<Mutual<VoiceMode, C.VoiceMode>>();
assertParity<Mutual<CodingAutoapproveMode, C.CodingAutoapproveMode>>();
assertParity<Mutual<ScheduleKind, C.ScheduleKind>>();
assertParity<Mutual<SkillTier, C.SkillTier>>();
assertParity<Mutual<SkillRiskTier, C.SkillRiskTier>>();
assertParity<Mutual<MemoryTrust, C.MemoryTrust>>();
assertParity<Mutual<EvolutionTriggerValue, C.EvolutionTriggerValue>>();

// --- value shapes (z.infer-derived) ---
assertParity<Mutual<CooldownState, C.CooldownState>>();
assertParity<Mutual<ToolSet, C.ToolSet>>();
assertParity<Mutual<ProfileMemoryScope, C.ProfileMemoryScope>>();
assertParity<Mutual<EvolutionEventPayload, C.EvolutionEventPayload>>();

// --- entity projections ---
assertParity<Mutual<Profile, C.Profile>>();
assertParity<Mutual<ProfileClass, C.ProfileClass>>();
assertParity<Mutual<CustomCompartment, C.CustomCompartment>>();
assertParity<Mutual<ConversationSummary, C.ConversationSummary>>();
assertParity<Mutual<ChatHistoryMessage, C.ChatHistoryMessage>>();
assertParity<Mutual<ScheduledTaskSummary, C.ScheduledTaskSummary>>();
assertParity<Mutual<EvolutionEventRow, C.EvolutionEventRow>>();

// --- transport DTOs ---
assertParity<Mutual<ProfileInput, C.ProfileInput>>();
assertParity<Mutual<RepoSummary, C.RepoSummary>>();
assertParity<Mutual<RepoInput, C.RepoInput>>();
assertParity<Mutual<RepoCloneAndAddInput, C.RepoCloneAndAddInput>>();
assertParity<Mutual<CurrentConversation, C.CurrentConversation>>();
assertParity<Mutual<ConversationStatusSummary, C.ConversationStatusSummary>>();
assertParity<Mutual<SkillListEntry, C.SkillListEntry>>();
assertParity<Mutual<ScheduledTaskAdminEntry, C.ScheduledTaskAdminEntry>>();
assertParity<Mutual<EvolutionEventEntry, C.EvolutionEventEntry>>();
assertParity<Mutual<TriggerReflectionOutcome, C.TriggerReflectionOutcome>>();
