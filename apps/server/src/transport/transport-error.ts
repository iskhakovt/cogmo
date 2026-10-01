import type { PipelineRunStatus } from "../agent/pipeline/store/index.js";

export type TransportError =
  | { code: "session_not_found"; sessionId: string }
  | { code: "identity_rejected" }
  | { code: "conversation_not_found" }
  | { code: "profile_not_found" }
  | { code: "profile_in_use" }
  | { code: "profile_name_taken" }
  | { code: "profile_class_in_use"; profileRefs: number }
  | { code: "profile_class_has_blocks"; keys: string[] }
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
  | { code: "pipelines_disabled" }
  | { code: "pipeline_run_not_found"; runId: string }
  | { code: "pipeline_gate_not_pending"; runId: string; status: PipelineRunStatus }
  | { code: "mcp_disabled" }
  | { code: "mcp_server_not_found"; serverId: string }
  | { code: "mcp_server_name_taken"; name: string }
  | { code: "mcp_invalid_config"; reason: string }
  | { code: "mcp_tool_not_found"; serverId: string; toolName: string }
  | { code: "mcp_connection_failed"; serverId: string; reason: string }
  /**
   * Scheduled task lookup failed — either the id doesn't exist, or it
   * belongs to another user (admin operations don't distinguish the
   * two so probing clients can't enumerate other users' tasks).
   */
  | { code: "schedule_not_found"; id: string }
  /**
   * The supplied id wasn't a UUID. Surfaced before the DB hit so the
   * user gets a clean error rather than a raw PG 22P02.
   */
  | { code: "schedule_id_malformed"; id: string }
  /**
   * `evolution.triggerReflection` was called on a deployment that didn't
   * wire a reflection trigger (test setups, future deployments that
   * disable evolution). The read methods on the same namespace stay
   * available — only the trigger surfaces this code.
   */
  | { code: "evolution_unavailable" }
  /**
   * `conversations.compact` was called on a deployment that didn't wire a
   * compaction driver. Every other method on the namespace stays available —
   * only the manual trigger surfaces this code.
   */
  | { code: "compaction_unavailable" }
  /**
   * The compaction driver threw — a misrouted summarization model, a provider
   * error, a DB failure. The driver runs inline with no Inngest retry budget
   * behind it, so the throw has to become a value here or it escapes the
   * `Result` contract and leaves the caller's pre-ack as the last thing the
   * user sees.
   *
   * `reason` reaches the user, so it is non-null only for what is known safe
   * and short: `ProviderConfigError`'s message, whose four throw sites name a
   * model or a provider row, and the bare HTTP status of a provider failure —
   * the status alone, never the body, since it is what tells the user whether
   * to wait and retry. `null` means the detail is in the log, and being null
   * rather than a sentinel string keeps the arms checkable by the compiler.
   * Everything else is withheld: a Drizzle failure stringifies as
   * `Failed query: <sql>` plus its bound params, which for this table is the
   * whole INSERT and the entire summary text.
   */
  | { code: "compaction_failed"; reason: string | null };
