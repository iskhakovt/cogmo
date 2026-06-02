import { z } from "zod";

/**
 * Runtime mirror of the `TransportError` discriminated union
 * (`src/transport/transport.ts`). Carried as the `data` of the single generic
 * oRPC `TRANSPORT_ERROR` so the typed client re-narrows on `code`. A
 * compile-time parity guard in `transport-error-schema.test.ts` fails typecheck
 * if this drifts from the TS union.
 */
export const TransportErrorSchema = z.discriminatedUnion("code", [
  z.object({ code: z.literal("session_not_found"), sessionId: z.string() }),
  z.object({ code: z.literal("identity_rejected") }),
  z.object({ code: z.literal("conversation_not_found") }),
  z.object({ code: z.literal("profile_not_found") }),
  z.object({ code: z.literal("profile_in_use") }),
  z.object({ code: z.literal("profile_name_taken") }),
  z.object({ code: z.literal("profile_class_in_use"), profileRefs: z.number() }),
  z.object({ code: z.literal("profile_class_not_found"), name: z.string() }),
  z.object({ code: z.literal("profile_class_name_taken"), name: z.string() }),
  z.object({ code: z.literal("unknown_profile_class"), name: z.string() }),
  z.object({ code: z.literal("compartment_cap_exceeded"), limit: z.number(), current: z.number() }),
  z.object({ code: z.literal("compartment_name_taken"), name: z.string() }),
  z.object({ code: z.literal("compartment_name_reserved"), name: z.string() }),
  z.object({ code: z.literal("compartment_name_invalid"), name: z.string() }),
  z.object({ code: z.literal("compartment_not_found"), name: z.string() }),
  z.object({ code: z.literal("compartment_unknown"), name: z.string() }),
  z.object({ code: z.literal("profile_class_name_invalid"), name: z.string() }),
  z.object({ code: z.literal("model_unavailable"), model: z.string() }),
  z.object({ code: z.literal("alias_taken") }),
  z.object({ code: z.literal("operation_not_permitted") }),
  z.object({ code: z.literal("access_denied"), reason: z.string() }),
  z.object({ code: z.literal("repo_not_found"), name: z.string() }),
  z.object({ code: z.literal("repo_name_taken"), name: z.string() }),
  z.object({ code: z.literal("repo_in_use"), name: z.string(), activeTasks: z.number() }),
  z.object({ code: z.literal("repo_invalid_input"), field: z.string(), reason: z.string() }),
  z.object({ code: z.literal("repo_clone_failed"), reason: z.string() }),
  z.object({ code: z.literal("repo_local_path_exists"), path: z.string() }),
  z.object({ code: z.literal("github_identity_unavailable"), reason: z.string() }),
  z.object({ code: z.literal("sandbox_disabled") }),
  z.object({ code: z.literal("task_not_found"), taskId: z.string() }),
  z.object({ code: z.literal("task_already_approved"), taskId: z.string() }),
  z.object({
    code: z.literal("task_not_pending_approval"),
    taskId: z.string(),
    status: z.string(),
  }),
  z.object({ code: z.literal("task_already_terminal"), taskId: z.string(), status: z.string() }),
  z.object({ code: z.literal("skills_disabled") }),
  z.object({ code: z.literal("skill_not_found"), name: z.string() }),
  z.object({ code: z.literal("skill_no_live_deploy"), name: z.string() }),
  z.object({ code: z.literal("skill_deploy_not_found"), pendingId: z.string() }),
  z.object({
    code: z.literal("skill_deploy_not_pending"),
    pendingId: z.string(),
    status: z.string(),
  }),
  z.object({
    code: z.literal("skill_deploy_register_failed"),
    pendingId: z.string(),
    reason: z.string(),
  }),
  z.object({ code: z.literal("mcp_disabled") }),
  z.object({ code: z.literal("mcp_server_not_found"), serverId: z.string() }),
  z.object({ code: z.literal("mcp_server_name_taken"), name: z.string() }),
  z.object({ code: z.literal("mcp_invalid_config"), reason: z.string() }),
  z.object({ code: z.literal("mcp_tool_not_found"), serverId: z.string(), toolName: z.string() }),
  z.object({ code: z.literal("mcp_connection_failed"), serverId: z.string(), reason: z.string() }),
  z.object({ code: z.literal("schedule_not_found"), id: z.string() }),
  z.object({ code: z.literal("schedule_id_malformed"), id: z.string() }),
  z.object({ code: z.literal("evolution_unavailable") }),
]);
