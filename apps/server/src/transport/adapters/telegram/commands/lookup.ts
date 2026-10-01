/** Resolve what the user typed, a conversation id or a profile name, to what it names. */

import type { Profile } from "../../../../agent/store/index.js";
import { isUuid } from "../../../../util/uuid.js";
import type { Transport, TransportError } from "../../../transport.js";

type ProfileResolution =
  | { kind: "ok"; profile: Profile }
  | { kind: "none" }
  | { kind: "ambiguous"; matches: ReadonlyArray<Profile> }
  | { kind: "error"; error: TransportError };

/**
 * Resolve a user-typed profile name. Org and user profiles can share a name (uniqueness is per
 * user_id), so when both exist we prefer the caller-owned one. Transport doesn't expose the
 * caller's userId directly, but `profiles.list` only returns org profiles + caller's own —
 * so any non-null userId in the result IS the caller's.
 */
export async function resolveProfileByName(
  transport: Transport,
  handle: string,
  name: string,
): Promise<ProfileResolution> {
  const list = await transport.profiles.list(handle);
  if (list.isErr()) return { kind: "error", error: list.error };
  const matches = list.value.filter((p) => p.name === name);
  const [firstMatch] = matches;
  if (!firstMatch) return { kind: "none" };
  if (matches.length === 1) return { kind: "ok", profile: firstMatch };
  // Exactly one user-owned match among several (org + user with same name) → pick the user one.
  const owned = matches.filter((p) => p.userId !== null);
  const [firstOwned] = owned;
  if (owned.length === 1 && firstOwned) return { kind: "ok", profile: firstOwned };
  return { kind: "ambiguous", matches };
}

export function ambiguityMessage(name: string, matches: ReadonlyArray<Profile>): string {
  const scopes = matches.map((p) => (p.userId === null ? "org" : "user")).join(", ");
  return `Profile name "${name}" is ambiguous (${matches.length} matches: ${scopes}). Use /profile list to see all and pick a unique one.`;
}

/**
 * Treat a `/resume <target>` argument as a UUID iff it matches the
 * standard 8-4-4-4-12 shape, of any version: the Telegram surface only
 * uses this to disambiguate UUID-looking strings from aliases — handing a
 * structurally-valid-but-unknown UUID to `resumeConversation` falls
 * through to an honest "not found" error.
 */
export function looksLikeUuid(s: string): boolean {
  return isUuid(s.toLowerCase());
}
