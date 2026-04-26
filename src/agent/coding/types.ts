import { z } from "zod";

/**
 * Subset of `devcontainer.json` Cogmo actually parses. Slice 1 stores `null`
 * (use the `cogmo/devbase` default); P2 implements full parsing via the
 * devcontainer CLI. Schema accepts unknown fields (`passthrough`) so a
 * complete `devcontainer.json` round-trips without loss while we narrow
 * the fields we care about.
 */
export const DevcontainerSpecSchema = z
  .object({
    image: z.string().optional(),
    features: z.record(z.string(), z.unknown()).optional(),
    postCreateCommand: z.union([z.string(), z.array(z.string())]).optional(),
    forwardPorts: z.array(z.union([z.number(), z.string()])).optional(),
  })
  .passthrough();
export type DevcontainerSpec = z.infer<typeof DevcontainerSpecSchema>;

/**
 * Branch + worktree path derived from the task id by the orchestrator's
 * `allocate-worktree` step. Stored as one JSONB blob (rather than two
 * nullable text columns) so the two fields are atomic by construction:
 * either the worktree is allocated (both present, validated by Zod on read
 * and write) or it isn't (column is null). No "half-allocated" intermediate
 * state is representable.
 */
export const WorktreeAssignmentSchema = z
  .object({
    branch: z.string().min(1),
    worktreePath: z.string().min(1),
  })
  .strict();
export type WorktreeAssignment = z.infer<typeof WorktreeAssignmentSchema>;

/**
 * Aggregated stats per coding task. All fields optional — populated
 * incrementally as the task runs (memory_bytes at task start from CLAUDE.md
 * `stat`, token counts from `turn.completed` events, container stats from
 * the supervisor's polling). Slice 1 only writes `memory_bytes`.
 */
export const ResourceUsageSchema = z
  .object({
    memory_bytes: z
      .object({
        managed: z.number().int().nonnegative(),
        user: z.number().int().nonnegative(),
        project: z.number().int().nonnegative(),
      })
      .optional(),
    cpu_seconds: z.number().nonnegative().optional(),
    memory_seconds: z.number().nonnegative().optional(),
    disk_bytes_written: z.number().int().nonnegative().optional(),
    network_bytes: z.number().int().nonnegative().optional(),
    tokens_input: z.number().int().nonnegative().optional(),
    tokens_output: z.number().int().nonnegative().optional(),
    /** USD spend reported by the CLI's `result` event, when available. */
    cost_usd: z.number().nonnegative().optional(),
  })
  .strict();
export type ResourceUsage = z.infer<typeof ResourceUsageSchema>;
