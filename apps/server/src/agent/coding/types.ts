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
 * Branch + transport-specific worktree material derived from the task id
 * by the orchestrator's `allocate-worktree` step. Stored as one JSONB blob
 * (rather than separate columns) so the variant is atomic by construction:
 * either the worktree is allocated (validated by Zod on read and write) or
 * it isn't (column is null). No "half-allocated" intermediate state is
 * representable.
 *
 * Discriminated by transport — `host-path` carries a host filesystem path
 * the local-Docker backend bind-mounts at `/workspace`; `git-remote` carries
 * only the slice-4 feature branch, because the run-branch is materialized
 * inside the sandbox by `git clone` (no host worktree).
 */
export const HostPathWorktreeAssignmentSchema = z
  .object({
    type: z.literal("host-path"),
    branch: z.string().min(1),
    worktreePath: z.string().min(1),
  })
  .strict();
export type HostPathWorktreeAssignment = z.infer<typeof HostPathWorktreeAssignmentSchema>;

export const GitRemoteWorktreeAssignmentSchema = z
  .object({
    type: z.literal("git-remote"),
    branch: z.string().min(1),
  })
  .strict();
export type GitRemoteWorktreeAssignment = z.infer<typeof GitRemoteWorktreeAssignmentSchema>;

export const WorktreeAssignmentSchema = z.discriminatedUnion("type", [
  HostPathWorktreeAssignmentSchema,
  GitRemoteWorktreeAssignmentSchema,
]);
export type WorktreeAssignment = z.infer<typeof WorktreeAssignmentSchema>;

/**
 * PR metadata captured by slice 4.0g's draft-PR step. Stored as one JSONB
 * blob (`coding_tasks.pr_metadata`) rather than four nullable columns so the
 * fields are atomic by construction: either the PR is open (all four
 * present, validated by Zod on read and write) or it isn't (column is
 * null). No "PR opened but URL not yet recorded" intermediate state is
 * representable.
 */
export const PrMetadataSchema = z
  .object({
    /** GitHub PR URL — `https://github.com/<owner>/<repo>/pull/<number>`. */
    url: z.string().url(),
    /** PR number — used by GitHub Mobile + future status updates. */
    number: z.number().int().positive(),
    /** Commit SHA the PR points at — captured from the `git push` step (4.0f). */
    branchSha: z.string().regex(/^[0-9a-f]{40}$/, "expected 40-char lowercase hex SHA"),
    /** ISO timestamp from the orchestrator at PR-open. */
    openedAt: z.string().datetime(),
  })
  .strict();
export type PrMetadata = z.infer<typeof PrMetadataSchema>;

/**
 * Aggregated stats per coding task. All fields optional — populated
 * incrementally as the task runs (memory_bytes at task start from CLAUDE.md
 * `stat`, token counts from `turn.completed` events, container stats from
 * the supervisor's polling). Slice 1 only writes `memory_bytes`.
 *
 * The `sandbox` block is honest raw telemetry: start/end timestamps and
 * provisioned (reserved) resources. Downstream tooling computes derived
 * quantities — wall_clock = deleted_at - created_at, billable estimate
 * ≈ wall_clock × provisioned × $rate. No `cpu_seconds` field here because
 * the Daytona SDK doesn't expose actual CPU consumption per sandbox, and
 * we don't want a field whose name implies precision the data lacks.
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
    /**
     * Execute-phase sandbox lifecycle. Captured Cogmo-side, so it works
     * uniformly across backends without depending on per-sandbox usage
     * APIs we don't have. `backend` mirrors `SandboxClient.backendId`
     * (free-form string — production values are `local-docker` /
     * `daytona`; test fakes pick whatever identifier their fixture
     * uses).
     */
    sandbox: z
      .object({
        backend: z.string().min(1),
        created_at: z.string().datetime(),
        deleted_at: z.string().datetime().optional(),
        provisioned: z
          .object({
            cpu: z.number().nonnegative(),
            memory_bytes: z.number().int().nonnegative(),
          })
          .strict(),
      })
      .strict()
      .optional(),
  })
  .strict();
export type ResourceUsage = z.infer<typeof ResourceUsageSchema>;
