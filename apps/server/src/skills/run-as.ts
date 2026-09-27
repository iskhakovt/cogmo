/**
 * Who a skill run acts for. A chat invocation runs as the turn's user through
 * the turn's scoped `Service`; `cogmo skills run` and cron fires build the
 * same scoped services for a stored identity (`resolveSkillRunAs`).
 */

import type { Service } from "../agent/service.js";
import type { AgentStore } from "../agent/store/index.js";
import { buildTurnService, type TurnServiceDeps } from "../agent/turn-service.js";
import type { SkillRunIdentity } from "./store/index.js";

/** The slice of a scoped `Service` that `ctx.memory` and `ctx.files` reach. */
export interface SkillRunServices {
  memory: Pick<Service["memory"], "recall" | "stageRetain">;
  files: Service["files"];
}

/** The user a skill run acts for, and the services scoped to them. */
export interface SkillRunAs {
  userId: string;
  service: SkillRunServices;
}

export interface ResolveSkillRunAsDeps extends TurnServiceDeps {
  agentStore: TurnServiceDeps["agentStore"] & Pick<AgentStore, "getProfile">;
}

/**
 * The run-as for a stored identity: the memory and file services a chat turn
 * under that user and profile gets (`buildTurnService`). A skill has no core
 * memory access, so the turn's core-memory scope is `none`.
 */
export async function resolveSkillRunAs(
  deps: ResolveSkillRunAsDeps,
  identity: SkillRunIdentity,
): Promise<SkillRunAs> {
  const profile = await deps.runInTx((tx) => deps.agentStore.getProfile(tx, identity.profileId));
  // An absent profile would build a service with no scope at all.
  if (profile === undefined) {
    throw new Error(`skill run-as profile ${identity.profileId} not found`);
  }
  const service = await buildTurnService(deps, {
    userId: identity.userId,
    profile,
    coreMemoryScope: { kind: "none" },
    coding: undefined,
    skills: undefined,
    scheduling: undefined,
    pipelines: undefined,
  });
  return { userId: identity.userId, service: { memory: service.memory, files: service.files } };
}
