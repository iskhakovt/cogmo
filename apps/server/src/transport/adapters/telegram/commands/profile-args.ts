/** Parsers for the `/profile scope` and `/profile stream` arguments. */

import { MemoryTrustSchema } from "../../../../agent/evolution/memory-extraction-schema.js";
import {
  type ProfileMemoryScope,
  ProfileMemoryScopeSchema,
} from "../../../../agent/store/schema.js";
import { CORE_LIST } from "./reply.js";

/**
 * Tokens that look like a scope-spec atom: the literal `clear` or any
 * `<key>=<value>` shape. Used by `splitScopeArgs` to find the name/spec
 * boundary when the profile name contains spaces.
 *
 * The shape check is keyword-agnostic on purpose — any `key=value`
 * routes to `parseScopeSpec`, where unknown keys (typos like
 * `compartment=` instead of `compartments=`) surface as a precise
 * "Unknown key …" error. Tying the shape to known keys would silently
 * drop typos into the name and fail with a confusing "No profile
 * named …" instead.
 */
function isScopeShape(token: string): boolean {
  return token.toLowerCase() === "clear" || /^[a-z]+=/i.test(token);
}

/**
 * Split `rest` into a (multi-token) profile name and the trailing scope
 * spec. Walks from the end so multi-word names work — e.g.
 * `["my", "work", "clear"]` → name = "my work", spec = ["clear"].
 *
 * Exposed for unit tests; the only caller is the `scope` subcommand
 * dispatcher in `handleProfile`.
 */
export function splitScopeArgs(rest: ReadonlyArray<string>): {
  name: string;
  scopeTokens: ReadonlyArray<string>;
} {
  let splitAt = rest.length;
  while (splitAt > 0 && isScopeShape(rest[splitAt - 1] ?? "")) splitAt--;
  return {
    name: rest.slice(0, splitAt).join(" "),
    scopeTokens: rest.slice(splitAt),
  };
}

/**
 * Pure parser for the scope spec — the tokens after `<name>` in
 * `/profile scope <name> …`. Exposed for unit testing.
 *
 * Forms:
 *   []                                        → show current scope
 *   ["clear"]                                 → set null (unrestricted)
 *   ["compartments=…", "trust=…"]             → set (both keys required, any order)
 */
export type ScopeSpec =
  | { kind: "show" }
  | { kind: "clear" }
  | { kind: "set"; scope: ProfileMemoryScope }
  | { kind: "error"; message: string };

export function parseScopeSpec(tokens: ReadonlyArray<string>): ScopeSpec {
  const trimmed = tokens.map((t) => t.trim()).filter(Boolean);
  if (trimmed.length === 0) return { kind: "show" };
  if (trimmed.length === 1 && trimmed[0]?.toLowerCase() === "clear") return { kind: "clear" };

  const collected: { compartments?: string[]; trust?: string[]; profileClasses?: string[] } = {};
  for (const token of trimmed) {
    const eq = token.indexOf("=");
    if (eq <= 0) {
      return {
        kind: "error",
        message: `Bad token "${token}". Expected compartments=…, trust=…, or classes=… (or "clear" alone).`,
      };
    }
    const key = token.slice(0, eq).toLowerCase();
    const values = token
      .slice(eq + 1)
      .split(",")
      .map((s) => s.trim())
      .filter(Boolean);
    // The DB / Zod schema field is `profileClasses`; the user-facing token
    // is `classes=` because the type-it-into-Telegram form benefits from
    // brevity. Translate at the parser boundary so the two layers can
    // evolve independently.
    if (key === "compartments" || key === "trust") {
      if (collected[key] !== undefined) {
        return {
          kind: "error",
          message: `Key "${key}" repeated. Combine values into a single comma-separated list.`,
        };
      }
      collected[key] = values;
    } else if (key === "classes") {
      if (collected.profileClasses !== undefined) {
        return {
          kind: "error",
          message: `Key "classes" repeated. Combine values into a single comma-separated list.`,
        };
      }
      collected.profileClasses = values;
    } else {
      return {
        kind: "error",
        message: `Unknown key "${key}". Expected compartments, trust, or classes.`,
      };
    }
  }
  if (!collected.compartments || !collected.trust) {
    return {
      kind: "error",
      message:
        "Both compartments=… and trust=… are required when setting a scope. Use 'clear' to remove.",
    };
  }

  const parsed = ProfileMemoryScopeSchema.safeParse(collected);
  if (!parsed.success) {
    return {
      kind: "error",
      message:
        `Invalid scope: ${parsed.error.issues.map((i) => i.message).join("; ")}\n` +
        `Compartments (core): ${CORE_LIST} (custom values from /compartments are also accepted)\n` +
        `Trust:        ${MemoryTrustSchema.options.join(", ")}`,
    };
  }
  return { kind: "set", scope: parsed.data };
}

/**
 * Split `rest` into a (multi-token) profile name and the trailing
 * `<key>=<value>` stream tokens. Walks from the end like `splitScopeArgs`
 * but the shape predicate is stricter: only `<key>=<value>` counts as a
 * trailing token. A profile literally named `clear` can be addressed
 * here (unlike `/profile scope`), since stream has no bare-keyword form.
 *
 * Exposed for unit tests; the only caller is the `stream` subcommand
 * dispatcher in `handleProfile`.
 */
export function splitStreamArgs(rest: ReadonlyArray<string>): {
  name: string;
  streamTokens: ReadonlyArray<string>;
} {
  let splitAt = rest.length;
  while (splitAt > 0 && /^[a-z]+=/i.test(rest[splitAt - 1] ?? "")) splitAt--;
  return {
    name: rest.slice(0, splitAt).join(" "),
    streamTokens: rest.slice(splitAt),
  };
}

/**
 * Pure parser for the stream spec — the tokens after `<name>` in
 * `/profile stream <name> …`. Exposed for unit testing.
 *
 * Forms:
 *   []                                        → show current prefs
 *   ["chunk=500"]                             → set chunk only
 *   ["edits=off"]                             → set edits only (on|off|true|false)
 *   ["chunk=500", "edits=off"]                → set both
 *
 * Range for chunk mirrors the `chk_profiles_stream_chunk_chars` CHECK:
 * 100..4000. The DB rejects out-of-range writes; this parser surfaces a
 * friendlier message before the round trip.
 */
export type StreamSpec =
  | { kind: "show" }
  | { kind: "set"; changes: { streamChunkChars?: number; streamEdits?: boolean } }
  | { kind: "error"; message: string };

export function parseStreamSpec(tokens: ReadonlyArray<string>): StreamSpec {
  const trimmed = tokens.map((t) => t.trim()).filter(Boolean);
  if (trimmed.length === 0) return { kind: "show" };
  const changes: { streamChunkChars?: number; streamEdits?: boolean } = {};
  for (const token of trimmed) {
    const eq = token.indexOf("=");
    if (eq <= 0) {
      return {
        kind: "error",
        message: `Bad token "${token}". Expected chunk=<n> or edits=on|off.`,
      };
    }
    const key = token.slice(0, eq).toLowerCase();
    const raw = token.slice(eq + 1).trim();
    if (key === "chunk") {
      if (changes.streamChunkChars !== undefined) {
        return { kind: "error", message: `Key "chunk" repeated.` };
      }
      const n = Number(raw);
      if (!Number.isInteger(n) || n < 100 || n > 4000) {
        return {
          kind: "error",
          message: `chunk must be an integer between 100 and 4000 (got "${raw}").`,
        };
      }
      changes.streamChunkChars = n;
    } else if (key === "edits") {
      if (changes.streamEdits !== undefined) {
        return { kind: "error", message: `Key "edits" repeated.` };
      }
      const v = raw.toLowerCase();
      if (v === "on" || v === "true") {
        changes.streamEdits = true;
      } else if (v === "off" || v === "false") {
        changes.streamEdits = false;
      } else {
        return {
          kind: "error",
          message: `edits must be on|off (got "${raw}").`,
        };
      }
    } else {
      return {
        kind: "error",
        message: `Unknown key "${key}". Expected chunk or edits.`,
      };
    }
  }
  return { kind: "set", changes };
}
