/**
 * Start a run of a user's active pipeline: pin the active definition version,
 * give the run its own conversation, route the user's reachable channel
 * sessions onto it, open the run on its first stage, and schedule that stage.
 *
 * Runs inside the `start_pipeline` tool's durable step, keyed on the tool
 * call's idempotency key. A retry after the commit must not open a second
 * conversation or move the sessions again, so the existing run is looked up
 * by key before anything is created. A recovered run still gets its first
 * `pipeline/stage.due` sent: the first attempt may have died between the
 * commit and the send, and the send is bus-deduped on the run cursor — while
 * the stage runner skips a delivery the run has already moved past.
 */

import type { Inngest } from "inngest";
import { err, ok, type Result } from "neverthrow";
import type { Transactor } from "../../db/index.js";
import { buildPipelineStageDueEvent } from "../../inngest/events.js";
import type { TransportStore } from "../../transport/store/index.js";
import type { AgentStore } from "../store/index.js";
import { findUnsupportedFeatures } from "./run-support.js";
import type { PipelineRunStore, PipelineStore } from "./store/index.js";

export interface StartPipelineRunDeps {
  runInTx: Transactor;
  pipelineStore: Pick<PipelineStore, "getActiveDefinition">;
  runStore: Pick<PipelineRunStore, "getRunByIdempotencyKey" | "insertOrRecoverRun">;
  agentStore: Pick<AgentStore, "createConversation">;
  transportStore: Pick<TransportStore, "findReachableChannelsForUserProfile" | "swapSession">;
  inngest: Pick<Inngest, "send">;
}

export interface StartPipelineRunArgs {
  userId: string;
  profileId: string;
  name: string;
  idempotencyKey: string;
}

export type StartPipelineRunError =
  | { kind: "not_active"; name: string }
  | { kind: "unsupported_features"; name: string; features: ReadonlyArray<string> }
  | { kind: "no_reachable_channel" };

export interface StartedPipelineRun {
  runId: string;
  conversationId: string;
  name: string;
  version: number;
  firstStage: string;
  recovered: boolean;
}

export async function startPipelineRun(
  deps: StartPipelineRunDeps,
  args: StartPipelineRunArgs,
): Promise<Result<StartedPipelineRun, StartPipelineRunError>> {
  const started = await deps.runInTx(
    async (tx): Promise<Result<StartedPipelineRun, StartPipelineRunError>> => {
      const definition = await deps.pipelineStore.getActiveDefinition(tx, args.userId, args.name);
      if (!definition) return err({ kind: "not_active", name: args.name });

      const existing = await deps.runStore.getRunByIdempotencyKey(tx, args.idempotencyKey);
      const firstStage = definition.compiled.stages[0]?.id;
      if (firstStage === undefined) {
        // The definition schema requires at least one stage; a row that
        // parsed through `jsonbZod` cannot reach here.
        throw new Error(`pipeline definition ${definition.id} has no stages`);
      }
      if (existing) {
        return ok({
          runId: existing.id,
          conversationId: existing.conversationId,
          name: definition.name,
          version: definition.version,
          firstStage,
          recovered: true,
        });
      }

      const unsupported = findUnsupportedFeatures(definition.compiled);
      if (unsupported.length > 0) {
        return err({ kind: "unsupported_features", name: args.name, features: unsupported });
      }

      const channels = await deps.transportStore.findReachableChannelsForUserProfile(
        tx,
        args.userId,
        args.profileId,
      );
      if (channels.length === 0) return err({ kind: "no_reachable_channel" });

      const conversation = await deps.agentStore.createConversation(tx, {
        userId: args.userId,
        profileId: args.profileId,
        isPrivate: true,
      });
      for (const ch of channels) {
        await deps.transportStore.swapSession(tx, ch.channelId, ch.platformAddress, {
          conversationId: conversation.id,
          status: "active",
          receive: ch.receive,
        });
      }

      const { kind, row } = await deps.runStore.insertOrRecoverRun(tx, {
        definitionId: definition.id,
        conversationId: conversation.id,
        currentStage: firstStage,
        idempotencyKey: args.idempotencyKey,
      });
      return ok({
        runId: row.id,
        conversationId: row.conversationId,
        name: definition.name,
        version: definition.version,
        firstStage,
        recovered: kind === "recovered",
      });
    },
  );
  if (started.isErr()) return started;

  await deps.inngest.send(
    buildPipelineStageDueEvent({
      runId: started.value.runId,
      stageId: started.value.firstStage,
      iteration: 0,
    }),
  );
  return started;
}
