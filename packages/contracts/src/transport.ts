/**
 * Transport admin-surface contracts shared with the web client: the
 * `code`-discriminated `TransportError` union plus the DTOs the oRPC layer
 * returns. Mirrored from backend `src/transport/transport.ts`; parity enforced
 * at compile time by `apps/server/src/test/contracts-parity.ts`.
 */

import type {
  CooldownState,
  EvolutionEventRow,
  ProfileMemoryScope,
  ScheduledTaskSummary,
  ToolSet,
} from "./domain.js";
import type {
  AutoRecallMode,
  CodingAutoapproveMode,
  McpServerApprovalStatus,
  McpTransportKind,
  SkillRiskTier,
  SkillTier,
  VoiceMode,
} from "./enums.js";

export type TransportError =
  | { code: "session_not_found"; sessionId: string }
  | { code: "identity_rejected" }
  | { code: "conversation_not_found" }
  | { code: "profile_not_found" }
  | { code: "profile_in_use" }
  | { code: "profile_name_taken" }
  | { code: "profile_class_in_use"; profileRefs: number }
  | { code: "profile_class_not_found"; name: string }
  | { code: "profile_class_name_taken"; name: string }
  | { code: "unknown_profile_class"; name: string }
  | { code: "compartment_cap_exceeded"; limit: number; current: number }
  | { code: "compartment_name_taken"; name: string }
  | { code: "compartment_name_reserved"; name: string }
  | { code: "compartment_name_invalid"; name: string }
  | { code: "compartment_not_found"; name: string }
  | { code: "compartment_unknown"; name: string }
  | { code: "profile_class_name_invalid"; name: string }
  | { code: "model_unavailable"; model: string }
  | { code: "alias_taken" }
  | { code: "operation_not_permitted" }
  | { code: "access_denied"; reason: string }
  | { code: "repo_not_found"; name: string }
  | { code: "repo_name_taken"; name: string }
  | { code: "repo_in_use"; name: string; activeTasks: number }
  | { code: "repo_invalid_input"; field: string; reason: string }
  | { code: "repo_clone_failed"; reason: string }
  | { code: "repo_local_path_exists"; path: string }
  | { code: "github_identity_unavailable"; reason: string }
  | { code: "sandbox_disabled" }
  | { code: "task_not_found"; taskId: string }
  | { code: "task_already_approved"; taskId: string }
  | { code: "task_not_pending_approval"; taskId: string; status: string }
  | { code: "task_already_terminal"; taskId: string; status: string }
  | { code: "skills_disabled" }
  | { code: "skill_not_found"; name: string }
  | { code: "skill_no_live_deploy"; name: string }
  | { code: "skill_deploy_not_found"; pendingId: string }
  | { code: "skill_deploy_not_pending"; pendingId: string; status: string }
  | { code: "skill_deploy_register_failed"; pendingId: string; reason: string }
  | { code: "mcp_disabled" }
  | { code: "mcp_server_not_found"; serverId: string }
  | { code: "mcp_server_name_taken"; name: string }
  | { code: "mcp_invalid_config"; reason: string }
  | { code: "mcp_tool_not_found"; serverId: string; toolName: string }
  | { code: "mcp_connection_failed"; serverId: string; reason: string }
  | { code: "schedule_not_found"; id: string }
  | { code: "schedule_id_malformed"; id: string }
  | { code: "evolution_unavailable" };

export interface ProfileInput {
  name: string;
  basePrompt: string;
  model: string;
  toolSet: ToolSet;
  memoryScope?: ProfileMemoryScope | null;
  streamChunkChars?: number;
  streamEdits?: boolean;
  codingAutoapproveMode?: CodingAutoapproveMode;
}

export interface RepoSummary {
  id: string;
  name: string;
  localPath: string;
  defaultBranch: string;
  remoteUrl: string;
  verifyCommand: string;
}

export interface RepoInput {
  name: string;
  localPath: string;
  remoteUrl: string;
  defaultBranch?: string;
  verifyCommand?: string;
  identityName?: string;
}

export interface RepoCloneAndAddInput {
  name: string;
  remoteUrl: string;
  defaultBranch?: string;
  verifyCommand?: string;
  identityName?: string;
}

export interface CurrentConversation {
  conversationId: string;
  profileId: string;
  profileName: string;
  model: string;
  voiceMode: VoiceMode | null;
  profileVoiceMode: VoiceMode;
}

export interface ConversationStatusSummary {
  conversationId: string;
  alias: string | undefined;
  cooldownState: CooldownState | null;
  createdAt: Date;
  lastMessageAt: Date | null;
  messageCount: number;
  profile: {
    id: string;
    name: string;
    model: string;
    toolCount: number;
    autoRecall: AutoRecallMode;
    memoryScope: ProfileMemoryScope | null;
    profileClass: string | null;
    voiceMode: VoiceMode;
  };
  voiceMode: VoiceMode | null;
  lastTurn: { inputTokens: number | null; outputTokens: number } | null;
  contextBudget: number | null;
  steeringRulesCount: number;
  mcp: {
    enabledServers: number;
    approvedTools: number;
    toolBudget: number;
  } | null;
}

export interface SkillListEntry {
  name: string;
  tier: SkillTier;
  riskTier: SkillRiskTier;
  disabled: boolean;
  gitSha: string;
}

/**
 * UI-facing projection of an MCP server for the admin table. A flat `transport`
 * kind replaces the full `McpServerConfig` union so command/url/header
 * value-sources (which can name secrets) never cross to the client.
 */
export interface McpServerSummary {
  id: string;
  name: string;
  transport: McpTransportKind;
  enabled: boolean;
  approvalStatus: McpServerApprovalStatus;
  toolCount: number;
  approvedToolCount: number;
  lastConnectedAt: Date | null;
  lastError: string | null;
  createdAt: Date;
}

export type ScheduledTaskAdminEntry = ScheduledTaskSummary;

export type EvolutionEventEntry = Omit<EvolutionEventRow, "userId">;

export type TriggerReflectionOutcome =
  | { status: "no_session" }
  | { status: "skipped"; reason: "conversation_not_found" | "profile_not_found" | "too_short" }
  | {
      status: "processed";
      eventId: string;
      ruleChanges: { extracted: number; reinforced: number; promoted: number };
      memoryCount: number;
      drained: number;
    };
