/**
 * Start a run of a user's active pipeline: pin the active definition version,
 * give the run its own conversation, route the user's reachable channel
 * sessions onto it, open the run on its first stage, and schedule that stage.
 *
 * Runs inside the `start_pipeline` tool's durable step, keyed on the tool
 * call's idempotency key. The existing run is looked up by key before
 * anything else — before the active-definition lookup too, since the active
 * version may have changed or been deactivated between an attempt that
 * committed and its retry. A recovered run resumes against the definition it
 * pinned, and its first `pipeline/stage.due` is sent again: the first attempt
 * may have died between the commit and the send, and the send is bus-deduped
 * on the run cursor while the stage runner skips a delivery the run has
 * already moved past.
 */

import type { Inngest } from "inngest";
import { err, ok, type Result } from "neverthrow";
import type { Transactor } from "../../db/index.js";
import { buildPipelineStageDueEvent } from "../../inngest/events.js";
import type { TransportStore } from "../../transport/store/index.js";
import type { AgentStore } from "../store/index.js";
import { findUnsupportedFeatures } from "./run-support.js";
import type { PipelineRunStore, PipelineStore } from "./store/index.js";
import type { PipelineDefinition } from "./types.js";

export interface StartPipelineRunDeps {
  runInTx: Transactor;
  pipelineStore: Pick<PipelineStore, "getActiveDefinition">;
  runStore: Pick<
    PipelineRunStore,
    "getRunByIdempotencyKey" | "getRunWithDefinition" | "insertOrRecoverRun"
  >;
  agentStore: Pick<AgentStore, "createConversation">;
  transportStore: Pick<TransportStore, "findReachableChannelsForUserProfile" | "swapSession">;
  inngest: Pick<Inngest, "send">;
  /** Channel types whose adapter posts gate keyboards (`AdapterModule.pipelineGates`). */
  gateChannelTypes: ReadonlySet<string>;
}

export interface StartPipelineRunArgs {
  userId: string;
  profileId: string;
  name: string;
  idempotencyKey: string;
  /** The chat conversation whose turn is starting the run. */
  originConversationId?: string;
}

export type StartPipelineRunError =
  | { kind: "not_active"; name: string }
  | { kind: "unsupported_features"; name: string; features: ReadonlyArray<string> }
  | { kind: "no_reachable_channel" }
  | { kind: "no_gate_channel" };

export interface StartedPipelineRun {
  runId: string;
  conversationId: string;
  name: string;
  version: number;
  firstStage: string;
  recovered: boolean;
}

function firstStageOf(definitionId: string, compiled: PipelineDefinition): string {
  const first = compiled.stages[0]?.id;
  // The definition schema requires at least one stage; a row that parsed
  // through `jsonbZod` cannot reach the throw.
  if (first === undefined) throw new Error(`pipeline definition ${definitionId} has no stages`);
  return first;
}

export async function startPipelineRun(
  deps: StartPipelineRunDeps,
  args: StartPipelineRunArgs,
): Promise<Result<StartedPipelineRun, StartPipelineRunError>> {
  const started = await deps.runInTx(
    async (tx): Promise<Result<StartedPipelineRun, StartPipelineRunError>> => {
      const existing = await deps.runStore.getRunByIdempotencyKey(tx, args.idempotencyKey);
      if (existing) {
        const pinned = await deps.runStore.getRunWithDefinition(tx, existing.id);
        if (!pinned) throw new Error(`pipeline run ${existing.id} lost its definition`);
        return ok({
          runId: existing.id,
          conversationId: existing.conversationId,
          name: pinned.definition.name,
          version: pinned.definition.version,
          firstStage: firstStageOf(pinned.definition.id, pinned.definition.compiled),
          recovered: true,
        });
      }

      const definition = await deps.pipelineStore.getActiveDefinition(tx, args.userId, args.name);
      if (!definition) return err({ kind: "not_active", name: args.name });

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
      const hasGates = definition.compiled.stages.some((stage) => stage.kind === "gate");
      if (hasGates && !channels.some((ch) => deps.gateChannelTypes.has(ch.channelType))) {
        return err({ kind: "no_gate_channel" });
      }

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
        currentStage: firstStageOf(definition.id, definition.compiled),
        idempotencyKey: args.idempotencyKey,
      });
      return ok({
        runId: row.id,
        conversationId: row.conversationId,
        name: definition.name,
        version: definition.version,
        firstStage: row.currentStage,
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
      ...(args.originConversationId !== undefined && {
        originConversationId: args.originConversationId,
      }),
    }),
  );
  return started;
}
