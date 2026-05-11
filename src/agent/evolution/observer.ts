/**
 * Observer — post-conversation extraction. Inngest function triggered by
 * `conversation/idle`. Sequence per fire:
 *
 *   1. extract corrections from the transcript → steering rules (with
 *      optional consolidation when active rule count crosses threshold)
 *   2. extract facts from the transcript → Hindsight (with full
 *      network + compartment + trust tags)
 *   3. drain pending memories for the user → classify each → Hindsight
 *
 * Observer is the sole writer to Hindsight. The live `memory_retain`
 * tool stages into `pending_memories`; step 3 catches those rows up
 * during the same idle pass.
 */

import { NonRetriableError } from "inngest";
import type { Transactor } from "../../db/index.js";
import { inngest } from "../../inngest/client.js";
import { conversationIdle } from "../../inngest/events.js";
import { type LlmProviderResolver, ProviderConfigError } from "../../llm/resolver.js";
import { logger } from "../../logger.js";
import type { MemoryProvider } from "../../memory/provider.js";
import type { TransportStore } from "../../transport/store/index.js";
import type { AgentStore } from "../store/index.js";
import { consolidateRules } from "./consolidate-rules.js";
import { buildRetainItems, classifyPendingMemories } from "./drain-pending-memories.js";
import { extractCorrections } from "./extract-corrections.js";
import { extractMemories } from "./extract-memories.js";

const MIN_MESSAGES_FOR_EXTRACTION = 4; // 2 turns minimum

/**
 * Max pending rows drained per Observer run. Caps the `step.run` output
 * payload so a post-migration backlog of thousands doesn't exceed
 * Inngest's run-state size limit. Remaining rows wait for the next
 * `conversation/idle` to drain.
 */
const PENDING_DRAIN_BATCH_SIZE = 100;

export interface ObserverDeps {
  runInTx: Transactor;
  agentStore: AgentStore;
  /**
   * Read-only slice of `TransportStore` — the Observer needs the
   * conversation's active channel types so the correction extractor can
   * scope new rules per channel. Kept as a `Pick<>` to make the
   * dependency explicit and minimal.
   */
  transportStore: Pick<TransportStore, "getActiveChannelTypes">;
  /**
   * Per-fire provider lookup. The extraction model is read from the
   * conversation's active profile inside the function (see `load-profile`
   * step), then handed to the resolver. The resolver's own per-model cache
   * amortizes the cost across fires. See `src/llm/resolver.ts`.
   */
  resolveProvider: LlmProviderResolver;
  // TODO: Route through Service.memory once retainBatch is on the Service interface (ACL boundary).
  // Currently called directly on the provider — safe because the Observer is a trusted internal consumer.
  memory: Pick<MemoryProvider, "retainBatch">;
}

/**
 * The minimal slice of Inngest's `step` API that `runObserver` uses. Lets
 * integration / unit tests call the handler directly with `(name, fn) => fn()`
 * — no Inngest dev server, no event-bus plumbing — while preserving the
 * production memoization shape. Step names are still threaded through so
 * structured-logging and tracing assertions can observe them.
 */
export interface ObserverStepHarness {
  run<T>(name: string, fn: () => Promise<T>): Promise<T>;
}

export interface ObserverEvent {
  data: { conversationId: string };
}

export type ObserverResult =
  | { status: "skipped"; reason: "conversation_not_found" | "profile_not_found" | "too_short" }
  | {
      status: "processed";
      conversationId: string;
      corrections: Awaited<ReturnType<typeof extractCorrections>>;
      consolidation: Awaited<ReturnType<typeof consolidateRules>> | null;
      memories: Awaited<ReturnType<typeof extractMemories>>;
      drained: { drained: number; byNetwork: Record<string, number> };
    };

/**
 * Pure handler for an Observer fire. Exported so tests can drive it with a
 * fake `step` that just calls the closure. The production wrapper in
 * `createObserver` registers it with Inngest under the
 * `conversation/idle` trigger.
 */
export async function runObserver(
  event: ObserverEvent,
  step: ObserverStepHarness,
  deps: ObserverDeps,
): Promise<ObserverResult> {
  const { agentStore, resolveProvider } = deps;
  const { conversationId } = event.data;

  const conv = await step.run("load-conversation", async () => {
    return deps.runInTx((tx) => agentStore.getConversation(tx, conversationId));
  });
  if (!conv) {
    logger.warn({ conversationId }, "observer: conversation not found");
    return { status: "skipped", reason: "conversation_not_found" };
  }

  // Resolve evolution model from the conversation's profile at fire
  // time (not bootstrap) so a profile using a cheaper chat model gets
  // extraction on that model too. `extractionModel` overrides the
  // chat model when set; otherwise the chat model is reused.
  const profile = await step.run("load-profile", async () => {
    return deps.runInTx((tx) => agentStore.getProfile(tx, conv.profileId));
  });
  if (!profile) {
    logger.warn({ conversationId, profileId: conv.profileId }, "observer: profile not found");
    return { status: "skipped", reason: "profile_not_found" };
  }
  const model = profile.extractionModel ?? profile.model;

  const history = await step.run("load-history", async () => {
    return deps.runInTx((tx) => agentStore.getHistory(tx, conversationId));
  });

  if (history.length < MIN_MESSAGES_FOR_EXTRACTION) {
    logger.debug(
      { conversationId, messageCount: history.length },
      "observer: conversation too short for extraction",
    );
    return { status: "skipped", reason: "too_short" };
  }

  // Load the user's `custom_compartments` once per fire — both the
  // transcript-extraction prompt (phase 2) and the pending-memory
  // classifier (phase 3) need them, and they're stable across the
  // run. Stored as `{ name, description }` only because that's what
  // the prompt-builder takes (id/createdAt are noise for the LLM).
  // Loaded after the too_short check so an idle on a brand-new
  // conversation skips the query.
  const customCompartments = await step.run("load-custom-compartments", async () => {
    const rows = await deps.runInTx((tx) => agentStore.listCustomCompartments(tx, conv.userId));
    return rows.map((c) => ({ name: c.name, description: c.description }));
  });

  // Distinct channel types active for this conversation drive correction
  // scoping — the extractor uses them so rules tied to a specific medium
  // (e.g. "no long voice notes here" on Telegram) land with
  // `channel_type` set rather than as global rules. May be empty if all
  // sessions have lapsed by the time the Observer fires; the extractor
  // falls back to global-only in that case.
  const activeChannelTypes = await step.run("load-active-channel-types", async () => {
    return deps.runInTx((tx) => deps.transportStore.getActiveChannelTypes(tx, conversationId));
  });

  // Resolve once per fire — outside `step.run` because the provider
  // instance isn't JSON-serializable. The resolver's own per-model
  // cache amortizes the cost across fires. Permanent config errors
  // (no routing row for the extraction model, missing secret) are
  // rewrapped as `NonRetriableError` so Inngest doesn't burn its
  // single retry on a misconfiguration; transient infra errors keep
  // their plain shape and follow the default retry path.
  let provider: Awaited<ReturnType<typeof resolveProvider>>["provider"];
  try {
    ({ provider } = await resolveProvider(model));
  } catch (err) {
    if (err instanceof ProviderConfigError) {
      throw new NonRetriableError(err.message, { cause: err });
    }
    throw err;
  }

  const result = await step.run("extract-corrections", async () => {
    return extractCorrections(history, conv.profileId, {
      provider,
      model,
      runInTx: deps.runInTx,
      store: agentStore,
      activeChannelTypes,
    });
  });

  const consolidation = result.consolidationNeeded
    ? await step.run("consolidate-rules", () =>
        consolidateRules(conv.profileId, {
          provider,
          model,
          runInTx: deps.runInTx,
          store: agentStore,
        }),
      )
    : null;

  // Phase 2: extract facts from the transcript into long-term memory.
  // `profile.profileClass` (when non-null) becomes a `profile_class:<class>`
  // tag on every retained memory, supporting speaker-driven isolation.
  const memoryResult = await step.run("extract-memories", async () => {
    return extractMemories(history, conv.userId, profile.profileClass, {
      provider,
      model,
      memory: deps.memory,
      customCompartments,
    });
  });

  // Phase 3: drain pending_memories — staged live retains and any
  // migration backfill — through the same classifier prompt. Split
  // across multiple step.runs so Inngest memoizes each: a delete
  // failure after a successful retain re-runs only the delete on
  // retry, not the LLM classifier or the retainBatch write.
  const pending = await step.run("load-pending-memories", async () => {
    return deps.runInTx((tx) =>
      agentStore.getPendingMemories(tx, conv.userId, PENDING_DRAIN_BATCH_SIZE),
    );
  });

  let drainResult: { drained: number; byNetwork: Record<string, number> } = {
    drained: 0,
    byNetwork: {},
  };

  if (pending.length > 0) {
    const classified = await step.run("classify-pending-memories", async () => {
      return classifyPendingMemories(pending, { provider, model, customCompartments });
    });

    if (classified.successful.length > 0) {
      // Each row carries its own staging profile's class (denormalised
      // by `getPendingMemories`'s LEFT JOIN). The drain stamps tags
      // per row, so a batch that mixes rows staged by different
      // profiles preserves each one's speaker-isolation boundary
      // regardless of which conversation triggered this Observer fire.
      const items = buildRetainItems(classified.successful);
      await step.run("retain-pending-memories", async () => {
        await deps.memory.retainBatch(conv.userId, items);
      });
      await step.run("delete-pending-memories", async () => {
        await deps.runInTx((tx) =>
          agentStore.deletePendingMemories(
            tx,
            classified.successful.map((c) => c.id),
          ),
        );
      });
      drainResult = {
        drained: classified.successful.length,
        byNetwork: classified.byNetwork,
      };
    }
  }

  return {
    status: "processed",
    conversationId,
    corrections: result,
    consolidation,
    memories: memoryResult,
    drained: drainResult,
  };
}

export function createObserver(deps: ObserverDeps) {
  return inngest.createFunction(
    {
      id: "observer",
      triggers: [conversationIdle],
      retries: 1,
      concurrency: { limit: 1, key: "event.data.conversationId" },
    },
    async ({ event, step }) => {
      // Inngest's `step.run` returns `Promise<Jsonify<T>>` (post-memoization
      // shape) whereas `ObserverStepHarness` is the simpler test-facing
      // contract returning `Promise<T>`. The runtime values are identical for
      // the JSON-safe payloads `runObserver` produces; the cast bridges the
      // two type universes without infecting the test harness type.
      return runObserver(event, step as unknown as ObserverStepHarness, deps);
    },
  );
}
