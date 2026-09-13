/**
 * Assemble the scoped `Service` one agent turn's tools run against. Shared by
 * `handle-message` and the pipeline stage turn so the memory scoping, the
 * restricted profile-class set and pending-memory staging have one
 * definition; each caller decides which optional namespaces (coding, skills,
 * scheduling, pipelines) its turn exposes.
 */

import type { Transactor } from "../db/index.js";
import type { MemoryProvider } from "../memory/provider.js";
import type { SkillsService } from "../skills/skills-service.js";
import type { CodingService } from "./coding/service.js";
import type { PipelinesService } from "./pipeline/pipelines-service.js";
import type { SchedulingService } from "./scheduling/scheduling-service.js";
import { createService, type Service } from "./service.js";
import type { AgentStore, Profile } from "./store/index.js";

export interface TurnServiceDeps {
  runInTx: Transactor;
  agentStore: Pick<
    AgentStore,
    "listProfileClasses" | "getCoreMemoryBlocks" | "upsertCoreMemoryBlock" | "stagePendingMemory"
  >;
  memory: MemoryProvider;
  fileService: Service["files"];
}

export interface TurnServiceArgs {
  /** The conversation's user — the memory bank owner. */
  userId: string;
  profile: Profile | undefined;
  coding: CodingService | undefined;
  skills: SkillsService | undefined;
  scheduling: SchedulingService | undefined;
  pipelines: PipelinesService | undefined;
}

export async function buildTurnService(
  deps: TurnServiceDeps,
  args: TurnServiceArgs,
): Promise<Service> {
  const { userId, profile } = args;

  // The user's restricted profile-class set, so the scoped service can fold in
  // the fail-closed NOT leaf. Keyed on the conversation user (the bank owner),
  // not `profile.userId` — an org profile (`profile.userId === null`) speaks
  // for the conversation user, and restricted-class semantics follow the
  // user's own registry. One extra round-trip per turn on a small table
  // indexed on user_id.
  //
  // FUTURE: deployments that have never used class restriction pay for this
  // round-trip every turn for nothing. A per-user cache (invalidated by
  // `setProfileClassRestricted` / `createProfileClass` / `deleteProfileClass`)
  // would close that gap, but it's strictly more code than the round-trip
  // costs at single-user scale — revisit when telemetry shows the read taking
  // a meaningful slice of turn latency.
  const restrictedClassNames = await deps
    .runInTx((tx) => deps.agentStore.listProfileClasses(tx, userId))
    .then((classes) => classes.filter((c) => c.restricted).map((c) => c.name));

  const coreMemory: Service["coreMemory"] = {
    get: () => deps.runInTx((tx) => deps.agentStore.getCoreMemoryBlocks(tx, userId)),
    update: (key, content) =>
      deps.runInTx((tx) => deps.agentStore.upsertCoreMemoryBlock(tx, { userId, key, content })),
  };

  return createService(
    deps.memory,
    userId,
    profile?.memoryScope ?? null,
    profile?.profileClass ?? null,
    restrictedClassNames,
    deps.fileService,
    coreMemory,
    async (content, opts) => {
      await deps.runInTx((tx) =>
        deps.agentStore.stagePendingMemory(tx, {
          userId,
          // Snapshot the staging profile so the Observer drain stamps the
          // right `profile_class:<class>` tag at retain time — without this, a
          // row staged by an `intimate`-class profile could be drained by an
          // idle on a `general`-class conversation and end up tagged as
          // `general`, leaking across speaker isolation.
          profileId: profile?.id ?? null,
          content,
          ...(opts?.context !== undefined && { context: opts.context }),
          source: "live_retain",
        }),
      );
    },
    args.coding,
    args.skills,
    args.scheduling,
    args.pipelines,
  );
}
