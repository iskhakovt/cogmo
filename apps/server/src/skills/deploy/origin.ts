import { match } from "ts-pattern";
import type { SkillRunIdentity } from "../store/index.js";

/** The `user_identities` row that acted, and its user. */
export interface SkillActor {
  identityId: string;
  userId: string;
}

/**
 * Who asked for a deploy or an enable. A schedule the request puts live runs
 * as `deployRunAs` derives from it; every caller names one, so none falls
 * back to the owner by omission.
 */
export type SkillDeployOrigin =
  /** A conversation asked (`register_skill`, a coding task's auto-register). */
  | { kind: "conversation"; userId: string; profileId: string }
  /** A user acted in a chat (an approval tap, `/enable`); `conversation` is that chat's. */
  | { kind: "user"; actor: SkillActor; conversation: SkillRunIdentity | null }
  /** The CLI, or an automated trigger with no conversation. */
  | { kind: "owner" };

/**
 * Who a schedule runs as once a request from `origin` puts it live. A
 * conversation runs it as its user and profile. A user acting in a chat runs
 * it as themselves, with that chat's conversation profile when the
 * conversation is theirs, else the default: their persona is known only from
 * a conversation of theirs. The owner runs it with the default profile.
 */
export function deployRunAs(owner: SkillRunIdentity, origin: SkillDeployOrigin): SkillRunIdentity {
  return match(origin)
    .with({ kind: "conversation" }, (o) => ({ userId: o.userId, profileId: o.profileId }))
    .with({ kind: "user" }, ({ actor, conversation }) => ({
      userId: actor.userId,
      profileId:
        conversation !== null && conversation.userId === actor.userId
          ? conversation.profileId
          : owner.profileId,
    }))
    .with({ kind: "owner" }, () => owner)
    .exhaustive();
}
