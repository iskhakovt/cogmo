/**
 * Observer — post-conversation extraction. Inngest function triggered by
 * `conversation/idle`. Sequence per fire:
 *
 *   1. extract corrections from the new messages → steering rules (with
 *      optional consolidation when active rule count crosses threshold)
 *   2. extract facts from the new messages → Hindsight (with full
 *      network + compartment + trust tags)
 *   3. drain pending memories for the user → classify each → Hindsight,
 *      withholding a row a `memory`-category rule forbids
 *
 * Steps 1 and 2 each read only the messages after their own cursor on the
 * conversation, in chunks, and advance it after each chunk (see
 * `observer-window.ts` and design/evolution.md → Observation Window).
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
 * its own phase, which reports an empty result, and the rest of the fire
 * still runs and records its audit row, which names the failed phases.
 * See `settlePhase`.
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
import {
  type AgentStore,
  bindsUnseenUserRule,
  type ObservedPhase,
  type PendingMemory,
} from "../store/index.js";
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
  correctionExtractionPrompt,
  type ExtractionResult,
  extractCorrections,
  type ObserverTranscript,
} from "./extract-corrections.js";
import { extractMemories, type MemoryExtractionResult } from "./extract-memories.js";
import { buildMemoryExtractionPrompt } from "./memory-extraction-schema.js";
import {
  chunkTokenLimit,
  estimateTokens,
  isCaughtUp,
  loadChunkTranscript,
  type PhasePlan,
  planPhaseChunks,
} from "./observer-window.js";

/**
 * Minimum transcript length (count of `messages` rows) before the
 * Observer will spend tokens on extraction. Exported because the
 * `/reflect` user-facing renderer needs to surface this value verbatim
 * in its "conversation too short" reply — duplicating the literal would
 * silently drift if the threshold changed.
 */
export const MIN_MESSAGES_FOR_EXTRACTION = 4; // 2 turns minimum

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
      eventId: string;
      corrections: Awaited<ReturnType<typeof extractCorrections>>;
      consolidation: Awaited<ReturnType<typeof consolidateRules>> | null;
      memories: Awaited<ReturnType<typeof extractMemories>>;
      drained: DrainPendingResult;
      failedPhases: ObserverPhase[];
      /** The messages each extraction phase extracted and advanced its cursor past this fire. */
      newMessages: Record<ObservedPhase, number>;
      /** Whether the extraction model's input budget was too small for a chunk, so extraction was skipped. */
      modelBudgetTooSmall: boolean;
    };

/** A phase's result, and whether that result is the fallback for a failure. */
interface SettledPhase<T> {
  phase: ObserverPhase;
  result: T;
  failed: boolean;
}

/** A phase's error no step's retries absorbed, held until the audit row is written. */
interface UnrecordedFailure {
  phase: ObserverPhase;
  err: unknown;
}

/** What a chunk's extraction step did: extracted it, or found another run had taken it. */
type ChunkExtraction<T> = { kind: "extracted"; result: T } | { kind: "taken" };

/** An extraction phase's outcome: the messages it advanced past, and whether its model was too small. */
interface ObservedPhaseOutcome<T> extends SettledPhase<T> {
  processed: number;
  budgetTooSmall: boolean;
}

/**
 * Run one phase of the fire so that its failure costs only that phase. The
 * catch wraps the phase's steps, so each keeps its retries. A step that failed
 * after them (`StepError`) is logged and replaced by `fallback`, marked
 * failed; that depends on nothing but the memoized failure, so a replay
 * reaches it again and plans the same steps after it. Any other error — every
 * error under the `/reflect` harness, which has no retries to exhaust — costs
 * the phase the same way and goes into `unrecorded`: the fire still records
 * what its other phases did, then throws it, so the user who asked sees the
 * failure.
 */
async function settlePhase<T>(
  phase: ObserverPhase,
  conversationId: string,
  fallback: T,
  run: () => Promise<T>,
  unrecorded: UnrecordedFailure[],
): Promise<SettledPhase<T>> {
  try {
    return { phase, result: await run(), failed: false };
  } catch (err) {
    if (err instanceof StepError) {
      logger.warn(
        { err, conversationId, phase, stepId: err.stepId },
        "observer: phase failed after retries — continuing without it",
      );
    } else {
      unrecorded.push({ phase, err });
      logger.error(
        { err, conversationId, phase },
        "observer: phase failed — recording the fire, then rethrowing",
      );
    }
    return { phase, result: fallback, failed: true };
  }
}

/**
 * Pure handler for an Observer fire. Exported so tests can drive it with a
 * fake `step` that just calls the closure. The production wrapper in
 * `createObserver` registers it with Inngest under the
 * `conversation/idle` trigger.
 *
 * `triggeredBy` defaults to `"idle"` — the autonomous path. The manual
 * trigger (`/reflect` via Transport) passes `"manual"` so the
 * `evolution_events` row records the source. Threaded as a runtime arg
 * rather than an Inngest event-payload field so the `conversation/idle`
 * event schema stays unchanged.
 */
export async function runObserver(
  event: ObserverEvent,
  step: ObserverStepHarness,
  deps: ObserverDeps,
  triggeredBy: EvolutionTrigger = "idle",
): Promise<ObserverResult> {
  const { agentStore, resolveProvider } = deps;
  const { conversationId } = event.data;
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

  // The fire's window: its top is the conversation's last message as of this
  // memoized read, so every replay sees the same one.
  const bounds = await step.run("load-observer-bounds", async () => {
    return deps.runInTx((tx) => agentStore.getObserverBounds(tx, conversationId));
  });

  if (bounds.messageCount < MIN_MESSAGES_FOR_EXTRACTION) {
    logger.debug(
      { conversationId, messageCount: bounds.messageCount },
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
  let resolved: Awaited<ReturnType<typeof resolveProvider>>;
  try {
    resolved = await resolveProvider(model);
  } catch (err) {
    if (err instanceof ProviderConfigError) {
      throw new NonRetriableError(err.message, { cause: err });
    }
    throw err;
  }
  const { provider } = resolved;

  // The Observer runs on the conversation's profile's model, so it shows that
  // model only the rules the profile's turns see: a third-party profile sees
  // none of the user's instruction rules (`admitsFirstParty`).
  const fire: ObserverFire = {
    conversationId,
    userId: conv.userId,
    profileId: conv.profileId,
    seesUserRules: admitsFirstParty(profile),
  };

  const windowDeps = { runInTx: deps.runInTx, store: agentStore };
  // Errors no step's retries absorbed: thrown once the audit row is written.
  const unrecorded: UnrecordedFailure[] = [];
  const settle = <T>(phase: ObserverPhase, fallback: T, run: () => Promise<T>) =>
    settlePhase(phase, conversationId, fallback, run, unrecorded);

  /**
   * One phase's chunks, planned in a step of that phase so its id derives
   * from durable state, cut to the limit the phase's system prompt leaves.
   */
  const planPhase = (phase: ObservedPhase, through: string, systemPrompt: () => Promise<string>) =>
    step.run(`plan-${phase}-chunks`, async () => {
      const promptTokens = estimateTokens(await systemPrompt());
      const plan = await planPhaseChunks(windowDeps, {
        conversationId,
        after: bounds.observedThrough[phase],
        through,
        tokenLimit: chunkTokenLimit(model, resolved.limits, promptTokens),
      });
      if (plan.kind === "budget_too_small") {
        logger.warn(
          { conversationId, phase, model, promptTokens },
          "observer: the extraction model's input budget can't hold its prompt and a chunk — extraction skipped",
        );
      }
      return plan;
    });

  const memoryRulesOf = () =>
    deps.runInTx((tx) =>
      agentStore.getMemoryRules(tx, { profileIds: [conv.profileId], userId: conv.userId }),
    );

  /**
   * Plan a phase and extract its chunks in order, advancing its cursor after
   * each, all inside the phase's own `settlePhase`s, so its failure costs
   * only it. A plan or chunk that fails ends the phase: the cursor stays after
   * the last chunk that succeeded, and the chunks after it wait for the next
   * fire. A plan of `held` leaves the window to a later fire without failing
   * the phase, and so does a chunk `heldChunk` reports was left unextracted.
   * `processed` counts the messages of the chunks whose cursor advanced.
   *
   * Another run on the conversation (a `/reflect` beside an idle fire) can
   * take a chunk: an extraction step that finds the phase's cursor moved off
   * the chunk's start extracts nothing, and an advance moves the cursor only
   * from the chunk's start. Either ends the phase without failing it.
   */
  async function observePhase<T>(
    phase: ObservedPhase,
    spec: {
      empty: T;
      held: T;
      combine: (total: T, chunk: T) => T;
      plan: (through: string) => Promise<PhasePlan | "held">;
      extract: (transcript: ObserverTranscript) => Promise<T>;
      heldChunk: (chunk: T) => boolean;
    },
  ): Promise<ObservedPhaseOutcome<T>> {
    const none = { phase, result: spec.empty, failed: false, processed: 0, budgetTooSmall: false };
    const top = bounds.lastMessageId;
    if (top === null || isCaughtUp(bounds, phase)) return none;
    const planned = await settle<PhasePlan | "held" | null>(phase, null, () => spec.plan(top));
    if (planned.result === null) return { ...none, failed: true };
    if (planned.result === "held") return { ...none, result: spec.held };
    if (planned.result.kind === "budget_too_small") return { ...none, budgetTooSmall: true };
    const plan = planned.result;
    let total = spec.empty;
    let processed = 0;
    let n = 0;
    // Sequential: each chunk's cursor advance must land before the next chunk.
    for (const chunk of plan.chunks) {
      n += 1;
      const extracted = await settle<ChunkExtraction<T> | null>(phase, null, () =>
        step.run(`extract-${phase}-${n}`, async (): Promise<ChunkExtraction<T>> => {
          const { observedThrough } = await deps.runInTx((tx) =>
            agentStore.getObserverBounds(tx, conversationId),
          );
          if (observedThrough[phase] !== chunk.after) {
            logger.info(
              { conversationId, phase, chunk },
              "observer: another run took this chunk — leaving it",
            );
            return { kind: "taken" };
          }
          const transcript = await loadChunkTranscript(windowDeps, {
            conversationId,
            chunk,
            tokenLimit: plan.tokenLimit,
          });
          return { kind: "extracted", result: await spec.extract(transcript) };
        }),
      );
      if (extracted.result === null) return { ...none, result: total, processed, failed: true };
      if (extracted.result.kind === "taken") return { ...none, result: total, processed };
      total = spec.combine(total, extracted.result.result);
      if (spec.heldChunk(extracted.result.result)) return { ...none, result: total, processed };
      const advanced = await settle<boolean | null>(phase, null, () =>
        step.run(`advance-${phase}-cursor-${n}`, () =>
          deps.runInTx((tx) =>
            agentStore.advanceObserverCursor(tx, {
              conversationId,
              phase,
              from: chunk.after,
              to: chunk.through,
            }),
          ),
        ),
      );
      if (advanced.result === null) return { ...none, result: total, processed, failed: true };
      if (!advanced.result) {
        logger.info(
          { conversationId, phase, chunk },
          "observer: another run moved the cursor off this chunk — stopping the phase",
        );
        return { ...none, result: total, processed };
      }
      processed += chunk.messages;
    }
    return { ...none, result: total, processed };
  }

  // Phase 1: extract corrections from the new messages into steering rules.
  // A failed chunk keeps what the chunks before it found; consolidation
  // follows the last chunk that completed.
  const corrections = await observePhase("corrections", {
    empty: NO_CORRECTIONS,
    held: NO_CORRECTIONS,
    combine: addCorrections,
    plan: (through) =>
      planPhase("corrections", through, async () => {
        const { system } = await correctionExtractionPrompt(fire, {
          runInTx: deps.runInTx,
          store: agentStore,
          activeChannelTypes,
        });
        return system;
      }),
    extract: (transcript) =>
      extractCorrections(transcript, fire, {
        provider,
        model,
        runInTx: deps.runInTx,
        store: agentStore,
        activeChannelTypes,
      }),
    heldChunk: () => false,
  });

  const consolidation = corrections.result.consolidationNeeded
    ? await settle("consolidation", null, () =>
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

  // Phase 2: extract facts from the new messages into long-term memory.
  // `profile.profileClass` (when non-null) becomes a `profile_class:<class>`
  // tag on every retained memory, supporting speaker-driven isolation.
  //
  // A fire whose profile can't see one of the user's memory rules stores
  // nothing such a rule binds: its memories window stays unplanned and its
  // cursor where it is, so a fire that can see the rule extracts it later.
  // The rules don't depend on the chunk, so one read decides before planning.
  // A chunk extraction skips for an unseen rule only if one was set since;
  // it, too, leaves the cursor where it is.
  const memories = await observePhase("memories", {
    empty: NO_MEMORIES,
    held: { ...NO_MEMORIES, skippedForUnseenRules: 1 },
    combine: addMemories,
    plan: async (through) => {
      if (!fire.seesUserRules) {
        const held = await step.run("check-unseen-memory-rules", async () => {
          const memoryRules = await memoryRulesOf();
          const binds = bindsUnseenUserRule(memoryRules, fire.seesUserRules);
          if (binds) {
            logger.info(
              { ...fire },
              "memory extraction skipped — a user's memory rule binds a profile that can't see it",
            );
          }
          return binds;
        });
        if (held) return "held";
      }
      return planPhase("memories", through, async () =>
        buildMemoryExtractionPrompt(
          customCompartments,
          (await memoryRulesOf()).map((r) => r.rule),
        ),
      );
    },
    extract: async (transcript) => {
      const memoryRules = await memoryRulesOf();
      return extractMemories(transcript, conv.userId, profile.profileClass, {
        provider,
        model,
        memory: deps.memory,
        customCompartments,
        memoryRules,
        fire,
      });
    },
    heldChunk: (chunk) => chunk.skippedForUnseenRules > 0,
  });

  // Phase 3: drain pending_memories — staged live retains, skill writes
  // and any migration backfill — through the same classifier prompt. Split
  // across multiple step.runs so Inngest memoizes each: a delete
  // failure after a successful retain re-runs only the delete on
  // retry, not the LLM classifier or the retainBatch write. A step
  // that fails for good ends the drain there, and every row it has not
  // deleted stays pending for the next fire.
  const drain = await settle(
    "drain",
    { drained: 0, byNetwork: {}, withheld: 0, deferredToFirstParty: 0 },
    async (): Promise<DrainPendingResult> => {
      const loaded = await step.run("load-pending-memories", async () => {
        return loadPendingBatch(fire, PENDING_DRAIN_BATCH_SIZE, {
          runInTx: deps.runInTx,
          store: agentStore,
        });
      });
      const batch = asPendingBatch(loaded);
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
  const outcome = {
    corrections: corrections.result,
    consolidation: consolidation?.result ?? null,
    memories: memories.result,
    drained: drain.result,
    failedPhases,
    newMessages: { corrections: corrections.processed, memories: memories.processed },
    modelBudgetTooSmall: corrections.budgetTooSmall || memories.budgetTooSmall,
  };

  // Persist the audit row last — once everything above is memoised, a retry
  // here only re-runs the DB insert, not the LLM-bearing steps. Status is
  // implied (only `processed` fires earn a row), so skipped branches above
  // returned early and never reach this point.
  const persist = step.run("persist-evolution-event", async () => {
    return deps.runInTx((tx) =>
      agentStore.recordEvolutionEvent(tx, {
        conversationId,
        userId: conv.userId,
        triggeredBy,
        payload: {
          ...outcome,
          messageCount: bounds.messageCount,
          profileId: conv.profileId,
          durationMs: Date.now() - startedAt,
        },
      }),
    );
  });

  let eventId: string;
  try {
    ({ id: eventId } = await persist);
  } catch (err) {
    // A `StepError` keeps its identity for the engine; the phase errors were
    // logged when they were caught.
    if (unrecorded.length === 0 || err instanceof StepError) throw err;
    throw new AggregateError(
      [...unrecorded.map((u) => u.err), err],
      `observer: ${unrecorded.map((u) => u.phase).join(", ")} failed, and the audit row could not be written`,
      { cause: unrecorded[0]?.err },
    );
  }
  const [failure] = unrecorded;
  if (failure !== undefined) throw failure.err;
  return { status: "processed", conversationId, eventId, ...outcome };
}

const NO_CORRECTIONS: ExtractionResult = {
  extracted: 0,
  reinforced: 0,
  contradictions: 0,
  retired: 0,
  reset: 0,
  promoted: 0,
  outOfScopeReinforcementsSkipped: 0,
  outOfScopeContradictionsSkipped: 0,
  unknownRuleReinforcementsSkipped: 0,
  droppedForContext: 0,
  consolidationNeeded: false,
};

/** Two chunks' corrections; whether to consolidate is the later chunk's call. */
function addCorrections(total: ExtractionResult, chunk: ExtractionResult): ExtractionResult {
  return {
    extracted: total.extracted + chunk.extracted,
    reinforced: total.reinforced + chunk.reinforced,
    contradictions: total.contradictions + chunk.contradictions,
    retired: total.retired + chunk.retired,
    reset: total.reset + chunk.reset,
    promoted: total.promoted + chunk.promoted,
    outOfScopeReinforcementsSkipped:
      total.outOfScopeReinforcementsSkipped + chunk.outOfScopeReinforcementsSkipped,
    outOfScopeContradictionsSkipped:
      total.outOfScopeContradictionsSkipped + chunk.outOfScopeContradictionsSkipped,
    unknownRuleReinforcementsSkipped:
      total.unknownRuleReinforcementsSkipped + chunk.unknownRuleReinforcementsSkipped,
    droppedForContext: total.droppedForContext + chunk.droppedForContext,
    consolidationNeeded: chunk.consolidationNeeded,
  };
}

const NO_MEMORIES: MemoryExtractionResult = {
  extracted: 0,
  byNetwork: {},
  skippedForUnseenRules: 0,
  droppedForContext: 0,
};

/** Two chunks' memories; a skip for unseen rules counts once per fire. */
function addMemories(
  total: MemoryExtractionResult,
  chunk: MemoryExtractionResult,
): MemoryExtractionResult {
  return {
    extracted: total.extracted + chunk.extracted,
    byNetwork: R.pipe(
      [...R.entries(total.byNetwork), ...R.entries(chunk.byNetwork)],
      R.groupBy(([network]) => network),
      R.mapValues((counts) => R.sumBy(counts, ([, n]) => n)),
    ),
    skippedForUnseenRules: Math.max(total.skippedForUnseenRules, chunk.skippedForUnseenRules),
    droppedForContext: total.droppedForContext + chunk.droppedForContext,
  };
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
    async ({ event, step }) => {
      // Inngest's `step.run` returns `Promise<Jsonify<T>>` (post-memoization
      // shape) whereas `ObserverStepHarness` is the simpler test-facing
      // contract returning `Promise<T>`. The runtime values are identical for
      // the JSON-safe payloads `runObserver` produces; the cast bridges the
      // two type universes without infecting the test harness type.
      // biome-ignore lint/plugin/no-unsafe-cast: Inngest Jsonify<T> vs harness T — identical at runtime for JSON-safe payloads.
      return runObserver(event, step as unknown as ObserverStepHarness, deps);
    },
  );
}
