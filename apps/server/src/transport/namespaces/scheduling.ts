import { err, ok, type Result } from "neverthrow";
import type { ScheduledTaskSummary } from "../../agent/scheduling/scheduling-service.js";
import type { ScheduledTask } from "../../agent/store/index.js";
import type { Transaction } from "../../db/index.js";
import { isUuid } from "../../util/uuid.js";
import type { TransportError } from "../transport-error.js";
import type { TransportContext } from "./context.js";

/**
 * One row of `scheduling.list` — the operator-facing projection of a
 * `scheduled_tasks` row. Aliased to `ScheduledTaskSummary` from the
 * service layer (identical fields, single source of truth). Kept as a
 * transport-namespace re-export so adapter authors get a name that
 * reads naturally at this layer and don't have to grep for the
 * service-layer name. If the two surfaces ever need to diverge
 * (e.g. admin-only fields like `sourceUserHandle` in a multi-tenant
 * future), break the alias then.
 */
export type ScheduledTaskAdminEntry = ScheduledTaskSummary;

/**
 * Scheduled-task admin surface — view + disable + enable + delete
 * the scheduled tasks the LLM (or the wizard) has created. Each
 * method is identity-checked via `platformUserHandle` against
 * `user_identities` and operates only on rows owned by that user;
 * unknown ids OR cross-user ids both surface as `schedule_not_found`
 * so probing clients can't enumerate other users' tasks.
 *
 * Mirrors the per-turn `SchedulingService` on the agent side but
 * lives at the transport layer because admin operations have no
 * conversation context (no profileId). The `/schedules` Telegram
 * command and any future CLI go through this.
 */
export interface SchedulingNamespace {
  /**
   * List all scheduled tasks for the user, including disabled rows.
   * Surfaces `identity_rejected` if the handle isn't authorized.
   */
  list(
    platformUserHandle: string,
  ): Promise<Result<ReadonlyArray<ScheduledTaskAdminEntry>, TransportError>>;
  /**
   * Soft-disable a scheduled task by id. Idempotent on
   * already-disabled rows (`alreadyAtState: true`). Refuses with
   * `schedule_not_found` for unknown ids OR ids owned by another user.
   */
  disable(
    platformUserHandle: string,
    id: string,
  ): Promise<Result<{ id: string; alreadyAtState: boolean }, TransportError>>;
  /**
   * Re-enable a previously-disabled scheduled task. Idempotent on
   * already-enabled rows (`alreadyAtState: true`).
   */
  enable(
    platformUserHandle: string,
    id: string,
  ): Promise<Result<{ id: string; alreadyAtState: boolean }, TransportError>>;
  /**
   * Permanently delete a scheduled task. No undo. Refuses with
   * `schedule_not_found` for unknown / cross-user ids.
   */
  delete(platformUserHandle: string, id: string): Promise<Result<{ id: string }, TransportError>>;
}

export function createScheduling(deps: TransportContext): SchedulingNamespace {
  const { channelId, runInTx, transportStore, agentStore } = deps;
  return {
    async list(platformUserHandle) {
      // Identity resolve + list in one tx (one BEGIN/COMMIT pair,
      // atomic snapshot).
      return await runInTx(async (tx) => {
        const user = await resolveTapperToUser(tx, platformUserHandle);
        if (user.isErr()) return err(user.error);
        const rows = await agentStore.listScheduledTasks(tx, user.value.userId);
        return ok(rows.map(toScheduledTaskAdminEntry));
      });
    },

    async disable(platformUserHandle, id) {
      return scheduledTaskSetEnabled(platformUserHandle, id, false);
    },

    async enable(platformUserHandle, id) {
      return scheduledTaskSetEnabled(platformUserHandle, id, true);
    },

    async delete(platformUserHandle, id) {
      if (!isUuid(id)) {
        return err({ code: "schedule_id_malformed" as const, id });
      }
      // Identity resolve + ownership check + delete in one tx so
      // the lookup and the write see the same snapshot.
      // `schedule_not_found` covers unknown ids AND cross-user ids
      // — same opaque-on-purpose response so a probing client
      // can't enumerate other users' tasks.
      return await runInTx(async (tx) => {
        const user = await resolveTapperToUser(tx, platformUserHandle);
        if (user.isErr()) return err(user.error);
        const row = await agentStore.getScheduledTask(tx, id);
        if (!row || row.userId !== user.value.userId) {
          return err({ code: "schedule_not_found" as const, id });
        }
        await agentStore.deleteScheduledTask(tx, id);
        return ok({ id });
      });
    },
  };

  /**
   * Variant of `checkSkillsTapper` that returns the resolved userId,
   * for operations on per-user rows. Takes an existing `tx` so the
   * identity check shares a transaction with the main operation —
   * one BEGIN/COMMIT pair, atomic snapshot. Same identity-rejection
   * semantics.
   */
  async function resolveTapperToUser(
    tx: Transaction,
    tapperPlatformHandle: string,
  ): Promise<Result<{ userId: string }, TransportError>> {
    const tapper = await transportStore.resolveUser(tx, channelId, tapperPlatformHandle);
    if (!tapper) {
      return err({ code: "identity_rejected" as const });
    }
    return ok({ userId: tapper.userId });
  }

  /**
   * Shared disable/enable body for `transport.scheduling.{disable,enable}`.
   * Validates the id format, identity-checks, looks up the row +
   * ownership, applies the requested state, and reports
   * `alreadyAtState: true` when the row was already in that state.
   *
   * All DB work happens in ONE transaction so the identity check and
   * the state update see the same snapshot — closes the race where
   * the user's identity row could be revoked between resolve and
   * update.
   *
   * Returns `schedule_not_found` for unknown OR cross-user ids — same
   * opaque-on-purpose response as `delete` so a probing client can't
   * enumerate other users' tasks.
   */
  async function scheduledTaskSetEnabled(
    platformUserHandle: string,
    id: string,
    enabled: boolean,
  ): Promise<Result<{ id: string; alreadyAtState: boolean }, TransportError>> {
    if (!isUuid(id)) {
      return err({ code: "schedule_id_malformed" as const, id });
    }
    return await runInTx(async (tx) => {
      const user = await resolveTapperToUser(tx, platformUserHandle);
      if (user.isErr()) return err(user.error);
      const row = await agentStore.getScheduledTask(tx, id);
      if (!row || row.userId !== user.value.userId) {
        return err({ code: "schedule_not_found" as const, id });
      }
      if (row.enabled === enabled) {
        return ok({ id, alreadyAtState: true });
      }
      await agentStore.setScheduledTaskEnabled(tx, id, enabled);
      return ok({ id, alreadyAtState: false });
    });
  }
}

/**
 * Project a `ScheduledTask` row onto the transport-layer admin entry
 * (drops `userId` + `profileId` + `source` + `catchupMissed` —
 * uninteresting at the admin surface). Kept here so adapters don't
 * import service internals.
 */
function toScheduledTaskAdminEntry(row: ScheduledTask): ScheduledTaskAdminEntry {
  return {
    id: row.id,
    kind: row.kind,
    cron: row.cron,
    prompt: row.prompt,
    timezone: row.timezone,
    nextRunAt: row.nextRunAt,
    lastRunAt: row.lastRunAt,
    enabled: row.enabled,
  };
}
