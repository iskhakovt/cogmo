/**
 * Observer — post-conversation extraction. Inngest function triggered by
 * `conversation/idle`. Sequence per fire:
 *
 *   1. extract corrections from each turn no fire has observed, one step
 *      per turn → steering rules (with optional consolidation when active
 *      rule count crosses threshold); see design/observation.md → Slice 1a
 *   2. extract facts from each turn no fire has observed, one step per
 *      turn → stored on the turn's row, then Hindsight (with full network +
 *      compartment + trust tags); see design/observation.md → Slice 2a
 *   3. drain pending memories for the user → classify each → Hindsight,
 *      withholding a row a `memory`-category rule forbids
 *
 * Steps 1 and 2 follow the steering rules the conversation's profile sees:
 * correction extraction lists the user's instruction rules beside the
 * learned ones, and memory extraction the `memory`-category rules.
 *
 * Observer is the sole writer to Hindsight. The live `memory_retain`
 * tool stages into `pending_memories`; step 3 catches those rows up
 * during the same idle pass.
 *
 * The phases are independent: a step that fails after its retries costs
 * its own phase, which reports an empty result (a turn phase: the turns it
 * finished before the failure), and the rest of the fire still runs and
 * records its audit row, which names the failed phases. See `settlePhase`
 * and `walkTurns`.
 */

import { NonRetriableError, StepError } from "inngest";
import * as R from "remeda";
import type { Transactor } from "../../db/index.js";
import { inngest } from "../../inngest/client.js";
import { conversationIdle } from "../../inngest/events.js";
import { type LlmProviderResolver, ProviderConfigError } from "../../llm/resolver.js";
import { logger } from "../../logger.js";
import type { MemoryProvider } from "../../memory/provider.js";
import type { TransportStore } from "../../transport/store/index.js";
import { admitsFirstParty } from "../core-memory/scope.js";
import type { AgentStore, PendingMemory } from "../store/index.js";
import { consolidateRules } from "./consolidate-rules.js";
import {
  buildRetainItems,
  classifyPendingMemories,
  type DrainPendingResult,
  loadPendingBatch,
  type ObserverFire,
  type PendingBatch,
} from "./drain-pending-memories.js";
import type { EvolutionTrigger, ObserverPhase } from "./event-schema.js";
import {
  addExtractionResults,
  type ExtractionResult,
  type ExtractionScope,
  NO_CORRECTIONS,
} from "./extract-corrections.js";
import type { MemoryExtractionResult } from "./extract-memories.js";
import { type DiscoverTurnsDeps, discoverTurns } from "./observation/discover-turns.js";
import {
  type ObserveTurnDeps,
  observeTurnCorrections,
} from "./observation/observe-turn-corrections.js";
import {
  type ObserveTurnMemoriesDeps,
  observeTurnMemories,
} from "./observation/observe-turn-memories.js";
import { type ReleaseHeldTurnsDeps, releaseHeldTurns } from "./observation/release-held-turns.js";
import type { MemoryTurnOutcome, TurnOutcome } from "./observation/turn-outcome.js";
import { type ObserverStepHarness, walkTurns } from "./observation/walk-turns.js";

export type { ObserverStepHarness } from "./observation/walk-turns.js";

/**
 * Max pending rows drained per Observer run. Caps the `step.run` output
 * payload so a post-migration backlog of thousands doesn't exceed
 * Inngest's run-state size limit. Remaining rows wait for the next
 * `conversation/idle` to drain.
 */
const PENDING_DRAIN_BATCH_SIZE = 100;

/**
 * Turns one fire observes per phase, oldest first; the rest wait for the
 * next fire. `/reflect` takes fewer, since the user waits on its reply.
 */
const TURNS_PER_PHASE: Readonly<Record<EvolutionTrigger, number>> = { idle: 10, manual: 3 };

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

export interface ObserverEvent {
  data: { conversationId: string };
}

/** Which fire this is: what triggered it, and the run that extracts. */
export interface ObserverRun {
  triggeredBy: EvolutionTrigger;
  /** Inngest's run id, or a fresh uuid per `/reflect`; recorded on each stored extraction. */
  runId: string;
}

export type ObserverResult =
  | {
      status: "skipped";
      /** `nothing_new`: no turn to observe, no held turn released, no staged row, no phase failed. */
      reason: "conversation_not_found" | "profile_not_found" | "nothing_new";
    }
  | {
      status: "processed";
      conversationId: string;
      eventId: string;
      corrections: ExtractionResult;
      consolidation: Awaited<ReturnType<typeof consolidateRules>> | null;
      memories: MemoryExtractionResult;
      drained: DrainPendingResult;
      failedPhases: ObserverPhase[];
    };

/** A phase's result, and whether that result is the fallback for a failure. */
interface SettledPhase<T> {
  phase: ObserverPhase;
  result: T;
  failed: boolean;
}

/**
 * Run one phase of the fire so that its permanent failure costs only that
 * phase. The catch wraps the phase's steps, so each keeps its retries; only
 * a step that failed after them (`StepError`) is logged and replaced by
 * `fallback`, marked failed. Anything else propagates — including every
 * error under the `/reflect` harness, which has no retries to exhaust and
 * reports a failure to the user who asked. The fallback depends on nothing
 * but the memoized failure, so a replay reaches it again and plans the same
 * steps after it.
 */
async function settlePhase<T>(
  phase: ObserverPhase,
  conversationId: string,
  fallback: T,
  run: () => Promise<T>,
): Promise<SettledPhase<T>> {
  try {
    return { phase, result: await run(), failed: false };
  } catch (err) {
    if (!(err instanceof StepError)) throw err;
    logger.warn(
      { err, conversationId, phase, stepId: err.stepId },
      "observer: phase failed after retries — continuing without it",
    );
    return { phase, result: fallback, failed: true };
  }
}

/** A turn phase's result, and how many turns it planned: a fire that planned none may have no news. */
interface TurnPhase<T> extends SettledPhase<T> {
  planned: number;
}

/**
 * The corrections phase: discover and plan the turns, then walk them, one
 * step each (design/observation.md → Slice 1a). Discovery is the phase's
 * cursor: a turn's row, written with its rule changes, keeps every later fire
 * from reading it again.
 */
async function observeCorrections(
  step: ObserverStepHarness,
  args: {
    conversationId: string;
    limit: number;
    scope: ExtractionScope;
    activeChannelTypes: ReadonlyArray<string>;
    deps: ObserveTurnDeps & DiscoverTurnsDeps;
  },
): Promise<TurnPhase<ExtractionResult>> {
  const { conversationId } = args;
  const walked = await walkTurns<Awaited<ReturnType<typeof discoverTurns>>, TurnOutcome>(step, {
    conversationId,
    phase: "corrections",
    discoverStepId: "discover-turns",
    discover: () =>
      discoverTurns(args.deps, { conversationId, phase: "corrections", limit: args.limit }),
    observe: (turn) =>
      observeTurnCorrections(args.deps, {
        conversationId,
        turn,
        scope: args.scope,
        activeChannelTypes: args.activeChannelTypes,
      }),
    deps: args.deps,
  });
  const applied = walked.outcomes.filter((o) => o.kind === "applied");
  const counts = R.countBy(walked.outcomes, (o) => o.kind);
  logger.info(
    {
      conversationId,
      applied: applied.length,
      skippedNotUserSpeech: walked.plan?.notUserSpeech ?? 0,
      skippedEmpty: counts.skipped ?? 0,
      retried: counts.retryLater ?? 0,
      failed: counts.failed ?? 0,
      taken: counts.taken ?? 0,
      droppedNoEvidence: R.sumBy(applied, (o) => o.droppedNoEvidence),
      remaining: walked.remaining,
    },
    "observer: corrections turns observed",
  );
  return {
    phase: "corrections",
    failed: walked.failed,
    planned: walked.plan?.turns.length ?? 0,
    result: applied.reduce((sum, o) => addExtractionResults(sum, o.result), NO_CORRECTIONS),
  };
}

/**
 * The memories phase: release the held turns nothing binds any more, discover
 * and plan, then walk the turns, one step each (design/observation.md → Slice
 * 2a). A turn's facts are stored on its row before they are retained, so a
 * re-run after the extraction committed re-sends them and calls no model.
 */
async function observeMemories(
  step: ObserverStepHarness,
  args: {
    limit: number;
    fire: ObserverFire;
    profileClass: string | null;
    runId: string;
    deps: ObserveTurnMemoriesDeps & DiscoverTurnsDeps & ReleaseHeldTurnsDeps;
  },
): Promise<TurnPhase<MemoryExtractionResult>> {
  const { conversationId } = args.fire;
  const walked = await walkTurns(step, {
    conversationId,
    phase: "memories",
    discoverStepId: "discover-memory-turns",
    discover: async () => {
      const { released } = await releaseHeldTurns(args.deps, { fire: args.fire });
      const plan = await discoverTurns(args.deps, {
        conversationId,
        phase: "memories",
        limit: args.limit,
      });
      return { ...plan, released };
    },
    observe: (turn): Promise<MemoryTurnOutcome> =>
      observeTurnMemories(args.deps, {
        turn,
        fire: args.fire,
        profileClass: args.profileClass,
        runId: args.runId,
      }),
    deps: args.deps,
  });
  const applied = walked.outcomes.filter((o) => o.kind === "applied");
  const counts = R.countBy(walked.outcomes, (o) => o.kind);
  const byNetwork = R.pipe(
    applied.flatMap((o) => Object.entries(o.byNetwork)),
    R.groupBy(([network]) => network),
    R.mapValues((entries) => R.sumBy(entries, ([, n]) => n)),
  );
  const result: MemoryExtractionResult = {
    extracted: R.sum(Object.values(byNetwork)),
    byNetwork,
    skippedForUnseenRules: counts.held ?? 0,
  };
  logger.info(
    {
      conversationId,
      applied: applied.length,
      extracted: result.extracted,
      held: counts.held ?? 0,
      released: walked.plan?.released ?? 0,
      skippedEmpty: counts.skipped ?? 0,
      retried: counts.retryLater ?? 0,
      failed: counts.failed ?? 0,
      taken: counts.taken ?? 0,
      droppedNoEvidence: R.sumBy(applied, (o) => o.droppedNoEvidence),
      remaining: walked.remaining,
    },
    "observer: memories turns observed",
  );
  return {
    phase: "memories",
    failed: walked.failed,
    // A released row lands in the same plan.
    planned: walked.plan?.turns.length ?? 0,
    result,
  };
}

/**
 * Pure handler for an Observer fire. Exported so tests can drive it with a
 * fake `step` that just calls the closure. The production wrapper in
 * `createObserver` registers it with Inngest under the
 * `conversation/idle` trigger.
 *
 * `run.triggeredBy` is `"idle"` on the autonomous path and `"manual"` for
 * `/reflect`, so the `evolution_events` row records the source. Threaded as a
 * runtime arg rather than an Inngest event-payload field so the
 * `conversation/idle` event schema stays unchanged.
 */
export async function runObserver(
  event: ObserverEvent,
  step: ObserverStepHarness,
  deps: ObserverDeps,
  run: ObserverRun,
): Promise<ObserverResult> {
  const { agentStore, resolveProvider } = deps;
  const { conversationId } = event.data;
  const { triggeredBy } = run;
  // Memoized, so every re-invocation measures `durationMs` from the fire's first step.
  const startedAt = await step.run("record-start-time", async () => Date.now());

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

  // Load the user's `custom_compartments` once per fire — both the
  // memory-extraction prompt (phase 2) and the pending-memory classifier
  // (phase 3) need them, and they're stable across the run. Stored as
  // `{ name, description }` only because that's what the prompt-builder
  // takes (id/createdAt are noise for the LLM).
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

  // The Observer runs on the conversation's profile's model, so it shows that
  // model only the rules the profile's turns see: a third-party profile sees
  // none of the user's instruction rules (`admitsFirstParty`).
  const fire: ObserverFire = {
    conversationId,
    userId: conv.userId,
    profileId: conv.profileId,
    seesUserRules: admitsFirstParty(profile),
  };
  const limit = TURNS_PER_PHASE[triggeredBy];

  // Phase 1: corrections, one turn per step, from the turns no fire has
  // observed for corrections.
  const corrections = await observeCorrections(step, {
    conversationId,
    limit,
    scope: fire,
    activeChannelTypes,
    deps: { provider, model, runInTx: deps.runInTx, store: agentStore },
  });

  const consolidation = corrections.result.consolidationNeeded
    ? await settlePhase("consolidation", conversationId, null, () =>
        step.run("consolidate-rules", () =>
          consolidateRules(conv.profileId, {
            provider,
            model,
            runInTx: deps.runInTx,
            store: agentStore,
          }),
        ),
      )
    : null;

  // Phase 2: memories, one turn per step, from the turns no fire has
  // observed for memories. `profile.profileClass` (when non-null) becomes a
  // `profile_class:<class>` tag on every retained fact, supporting
  // speaker-driven isolation.
  const memories = await observeMemories(step, {
    limit,
    fire,
    profileClass: profile.profileClass,
    runId: run.runId,
    deps: {
      provider,
      model,
      customCompartments,
      runInTx: deps.runInTx,
      store: agentStore,
      memory: deps.memory,
    },
  });

  // Phase 3: drain pending_memories — staged live retains, skill writes
  // and any migration backfill — through the same classifier prompt. Split
  // across multiple step.runs so Inngest memoizes each: a delete
  // failure after a successful retain re-runs only the delete on
  // retry, not the LLM classifier or the retainBatch write. A step
  // that fails for good ends the drain there, and every row it has not
  // deleted stays pending for the next fire.
  let stagedRows = 0;
  const drain = await settlePhase(
    "drain",
    conversationId,
    { drained: 0, byNetwork: {}, withheld: 0, deferredToFirstParty: 0 },
    async (): Promise<DrainPendingResult> => {
      const loaded = await step.run("load-pending-memories", async () => {
        return loadPendingBatch(fire, PENDING_DRAIN_BATCH_SIZE, {
          runInTx: deps.runInTx,
          store: agentStore,
        });
      });
      const batch = asPendingBatch(loaded);
      stagedRows = batch.pending.length;
      if (batch.pending.length === 0) {
        return {
          drained: 0,
          byNetwork: {},
          withheld: 0,
          deferredToFirstParty: batch.deferredToFirstParty,
        };
      }

      const classified = await step.run("classify-pending-memories", async () => {
        return classifyPendingMemories(batch.pending, {
          provider,
          model,
          customCompartments,
          fire,
          runInTx: deps.runInTx,
          store: agentStore,
        });
      });
      const { successful } = classified;
      // A classification memoized before results carried `withheld` or
      // `deferredToFirstParty` replays without them.
      const withheld = classified.withheld ?? [];
      const deferredToFirstParty =
        batch.deferredToFirstParty + (classified.deferredToFirstParty ?? 0);
      if (successful.length === 0 && withheld.length === 0) {
        return { drained: 0, byNetwork: {}, withheld: 0, deferredToFirstParty };
      }

      // Each row carries its own staging profile's class (denormalised
      // by `getPendingMemories`'s LEFT JOIN). The drain stamps tags
      // per row, so a batch that mixes rows staged by different
      // profiles preserves each one's speaker-isolation boundary
      // regardless of which conversation triggered this Observer fire.
      // A batch that is all withheld has nothing to retain; the branch
      // reads the memoized classification, so a replay plans the same steps.
      if (successful.length > 0) {
        const items = buildRetainItems(successful);
        await step.run("retain-pending-memories", async () => {
          await deps.memory.retainBatch(conv.userId, items);
        });
      }
      await step.run("delete-pending-memories", async () => {
        await deps.runInTx((tx) =>
          agentStore.deletePendingMemories(tx, [...successful.map((c) => c.id), ...withheld]),
        );
      });
      return {
        drained: successful.length,
        byNetwork: classified.byNetwork,
        withheld: withheld.length,
        deferredToFirstParty,
      };
    },
  );

  // Derived from the memoized failures alone, so every replay computes the
  // same list. Consolidation that never ran is not a phase that failed.
  const failedPhases = [corrections, consolidation, memories, drain].flatMap((p) =>
    p?.failed === true ? [p.phase] : [],
  );
  // From memoized plans and the memoized drain batch, so every replay agrees.
  if (
    corrections.planned === 0 &&
    memories.planned === 0 &&
    stagedRows === 0 &&
    failedPhases.length === 0
  ) {
    logger.debug({ conversationId }, "observer: nothing new to observe");
    return { status: "skipped", reason: "nothing_new" };
  }
  const outcome = {
    corrections: corrections.result,
    consolidation: consolidation?.result ?? null,
    memories: memories.result,
    drained: drain.result,
    failedPhases,
  };

  // Persist the audit row last — once everything above is memoised, a retry
  // here only re-runs the DB insert, not the LLM-bearing steps. Status is
  // implied (only `processed` fires earn a row), so skipped branches above
  // returned early and never reach this point.
  const { id: eventId } = await step.run("persist-evolution-event", async () => {
    return deps.runInTx(async (tx) => {
      const stats = await agentStore.getConversationStats(tx, conversationId);
      // Loaded by this run's first steps, and no code deletes conversations.
      if (stats === undefined) throw new Error(`conversation ${conversationId} is missing`);
      return agentStore.recordEvolutionEvent(tx, {
        conversationId,
        userId: conv.userId,
        triggeredBy,
        payload: {
          ...outcome,
          messageCount: stats.messageCount,
          profileId: conv.profileId,
          durationMs: Date.now() - startedAt,
        },
      });
    });
  });

  return { status: "processed", conversationId, eventId, ...outcome };
}

/** A batch memoized as a bare row list replays as one with nothing deferred. */
function asPendingBatch(loaded: PendingBatch | ReadonlyArray<PendingMemory>): PendingBatch {
  return "pending" in loaded ? loaded : { pending: loaded, deferredToFirstParty: 0 };
}

export function createObserver(deps: ObserverDeps) {
  return inngest.createFunction(
    {
      id: "observer",
      triggers: [conversationIdle],
      retries: 1,
      concurrency: { limit: 1, key: "event.data.conversationId" },
    },
    async ({ event, step, runId }) => {
      // Inngest's `step.run` returns `Promise<Jsonify<T>>` (post-memoization
      // shape) whereas `ObserverStepHarness` is the simpler test-facing
      // contract returning `Promise<T>`. The runtime values are identical for
      // the JSON-safe payloads `runObserver` produces; the cast bridges the
      // two type universes without infecting the test harness type.
      // biome-ignore lint/plugin/no-unsafe-cast: Inngest Jsonify<T> vs harness T — identical at runtime for JSON-safe payloads.
      return runObserver(event, step as unknown as ObserverStepHarness, deps, {
        triggeredBy: "idle",
        runId,
      });
    },
  );
}
