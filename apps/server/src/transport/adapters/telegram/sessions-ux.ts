/**
 * Pure render helpers for Telegram /sessions and /profile lists.
 *
 * Returns a neutral shape (text + optional inline keyboard buttons) so tests
 * don't need grammY; the adapter wires the buttons to an `InlineKeyboard`.
 */

import { formatRemainingCooldown, isInCooldown } from "../../../agent/cooldown.js";
import type { ConversationSummary, Profile } from "../../../agent/store/index.js";
import type { ProfileMemoryScope } from "../../../agent/store/schema.js";
import { truncate } from "../../../util/string.js";
import type { ConversationStatusSummary } from "../../transport.js";

/** Telegram's inline-keyboard button density is workable up to ~10 rows before scrolling feels bad. */
export const KEYBOARD_THRESHOLD = 10;

export interface InlineButton {
  text: string;
  callbackData: string;
}

export interface RenderedList {
  text: string;
  /** When present, the adapter should render as an inline keyboard. */
  buttons?: ReadonlyArray<InlineButton>;
}

export function renderSessionsList(
  summaries: ReadonlyArray<ConversationSummary>,
  opts: { currentConversationId?: string | undefined; threshold?: number } = {},
): RenderedList {
  const threshold = opts.threshold ?? KEYBOARD_THRESHOLD;
  if (summaries.length === 0) {
    return { text: "No other conversations yet." };
  }

  if (summaries.length <= threshold) {
    // Inline keyboard — one button per conversation, label = alias or preview.
    const buttons = summaries.map((s) => ({
      text: labelFor(s, s.id === opts.currentConversationId),
      callbackData: `resume:${s.alias ?? s.id}`,
    }));
    return { text: "Select a conversation:", buttons };
  }

  // Too many — numbered text list with `/resume <alias|uuid>` as the action. Unaliased rows
  // still get an actionable command; `handleResume` accepts both alias and UUID forms.
  const lines = summaries.map((s, i) => {
    const marker = s.id === opts.currentConversationId ? " (current)" : "";
    const target = `/resume ${s.alias ?? s.id}`;
    return `${i + 1}. ${labelFor(s, false)} — ${target}${marker}`;
  });
  return { text: lines.join("\n") };
}

export function renderProfileList(
  profiles: ReadonlyArray<Profile>,
  opts: {
    currentProfileId?: string | undefined;
    customCompartments?: ReadonlySet<string>;
    restrictedClasses?: ReadonlySet<string>;
  } = {},
): RenderedList {
  if (profiles.length === 0) {
    return { text: "No profiles available." };
  }
  let sawRestrictedClass = false;
  const lines = profiles.map((p) => {
    const owner = p.userId === null ? "org" : "you";
    const current = p.id === opts.currentProfileId ? " ← current" : "";
    // Memory scope is null for most profiles (unrestricted) — only annotate
    // when set, so the common case stays compact. Wraps the canonical
    // `formatScope` form so list and show views never drift in sync.
    const scope = p.memoryScope
      ? ` [${formatScope(
          p.memoryScope,
          opts.customCompartments,
          opts.restrictedClasses,
          p.profileClass,
        )}]`
      : "";
    // Profile class is null for unclassed profiles — surface only when set
    // so unclassed deployments don't see clutter. Restricted classes get a
    // trailing `!` marker (matching the convention used inside `formatScope`
    // — `*` is already taken for custom compartments on the same line).
    const klassRestricted =
      p.profileClass !== null && (opts.restrictedClasses?.has(p.profileClass) ?? false);
    if (klassRestricted) sawRestrictedClass = true;
    const klass = p.profileClass ? ` [class=${p.profileClass}${klassRestricted ? "!" : ""}]` : "";
    return `• ${p.name} (${owner}, ${p.model})${scope}${klass}${current}`;
  });
  // The list's `formatScope` calls already append `(! = restricted)` when
  // a scope-rendered class is restricted, but a profile can carry a
  // restricted `[class=…]` annotation while having `memoryScope = null`
  // (so `formatScope` is never invoked). Append the legend at list level
  // so the marker isn't unexplained in that path.
  // Legend wording matches `formatScope` (`(! = restricted)`) so the two
  // surfaces don't drift — the marker only appears on classes anyway, so
  // the "class" suffix from earlier drafts was redundant.
  const legend = sawRestrictedClass ? "\n(! = restricted)" : "";
  return { text: `${lines.join("\n")}${legend}` };
}

/**
 * Canonical render for a profile's memory scope. Used both by the
 * `/profile scope` show-reply (commands.ts) and the `/profile list`
 * annotation above. Single source of truth so the two views can't drift.
 *
 * When `customCompartments` is supplied (the user's `custom_compartments`
 * names), each compartment that's a custom value gets a trailing `*` and
 * a `(* = custom)` legend is appended — gives the operator a visual cue
 * that the registry-extension mechanism actually fired without changing
 * the canonical compartment value. Omit `customCompartments` (or pass
 * empty) on call sites that don't have it loaded; the output stays
 * unmarked rather than misleading.
 *
 * Stale-reference caveat: a scope referencing a since-deleted custom
 * (e.g. `compartments: music` after `/compartments rm music`) renders
 * bare — the value isn't in `CORE_COMPARTMENTS` *and* isn't in the
 * loaded customs set, so it gets no `*`. A reader could infer "core"
 * when the value is actually orphaned. New profile writes can't create
 * this state (`findUnknownCompartmentImpl` rejects unknown values on
 * create/update), but pre-existing scopes survive deletion of the
 * compartment they reference (forward-only delete by design — see
 * `Transport.compartments.delete`). Acceptable at single-user scale;
 * promote to a follow-up if multi-user or longer-lived scopes make
 * orphaned references common enough to confuse readers.
 */
export function formatScope(
  scope: ProfileMemoryScope | null,
  customCompartments?: ReadonlySet<string>,
  restrictedClasses?: ReadonlySet<string>,
  speakerClass?: string | null,
): string {
  if (scope === null) return "unrestricted (recalls all memories)";
  let sawCustom = false;
  let sawRestricted = false;
  const renderedCompartments = scope.compartments.map((c) => {
    const isCustom = customCompartments?.has(c) ?? false;
    if (isCustom) sawCustom = true;
    return isCustom ? `${c}*` : c;
  });
  const parts = [
    `compartments: ${renderedCompartments.join(", ")}`,
    `trust: ${scope.trust.join(", ")}`,
  ];
  if (scope.profileClasses !== undefined && scope.profileClasses.length > 0) {
    // The Service auto-includes the speaker's own class in the recall
    // filter so a profile always sees its own writes, even when the
    // operator's `classes=…` doesn't list it. Surface that auto-include
    // here so the rendered scope reflects the *effective* filter, not
    // just the stored config — otherwise the operator can be surprised
    // by what `private` actually recalls when its class is "intimate"
    // and they wrote `classes=general`.
    const speakerAutoIncluded =
      speakerClass !== undefined &&
      speakerClass !== null &&
      !scope.profileClasses.includes(speakerClass);
    const effective = speakerAutoIncluded
      ? [...scope.profileClasses, speakerClass]
      : scope.profileClasses;
    const renderedClasses = effective.map((c) => {
      const isRestricted = restrictedClasses?.has(c) ?? false;
      if (isRestricted) sawRestricted = true;
      const annotated = isRestricted ? `${c}!` : c;
      return speakerAutoIncluded && c === speakerClass ? `${annotated} (speaker)` : annotated;
    });
    parts.push(`classes: ${renderedClasses.join(", ")}`);
  }
  const main = parts.join(" / ");
  const legends: string[] = [];
  if (sawCustom) legends.push("* = custom");
  if (sawRestricted) legends.push("! = restricted");
  return legends.length > 0 ? `${main} (${legends.join("; ")})` : main;
}

export function renderModelList(
  models: ReadonlyArray<string>,
  opts: { currentModel?: string | undefined } = {},
): string {
  if (models.length === 0) return "No user-selectable models configured.";
  return models
    .map((m) => {
      const current = m === opts.currentModel ? " ← current" : "";
      return `• ${m}${current}`;
    })
    .join("\n");
}

function labelFor(s: ConversationSummary, current: boolean): string {
  const head = s.alias ?? truncate(s.lastMessagePreview, 40) ?? "(untitled)";
  const suffix = current ? " ← current" : "";
  return `${head}${suffix}`;
}

/**
 * Render the `/status` reply. Pure function over a `ConversationStatusSummary`
 * so the dispatch in `commands.ts` stays trivial. `now` is injected so tests
 * can pin the relative-age line; production callers pass `new Date()`.
 *
 * Layout follows the existing one-line-per-fact convention used by `/voice`
 * and `/sessions` rather than tables — Telegram's plain-text rendering is
 * the lowest common denominator and survives the HTML-fallback path that
 * the streaming adapter already exercises.
 */
export function renderConversationStatus(
  summary: ConversationStatusSummary,
  opts: {
    now?: Date;
    customCompartments?: ReadonlySet<string>;
    restrictedClasses?: ReadonlySet<string>;
  } = {},
): string {
  const now = opts.now ?? new Date();
  const idTail = summary.conversationId.slice(-8);
  const head = summary.alias ?? `id ${idTail}`;
  const ageMs = now.getTime() - summary.createdAt.getTime();
  const idleMs =
    summary.lastMessageAt === null ? null : now.getTime() - summary.lastMessageAt.getTime();
  const status = renderStatusFragment(summary, now);
  const lines: string[] = [
    "Conversation",
    `  ${head} · status: ${status} · age: ${formatDuration(ageMs)}`,
    `  messages: ${summary.messageCount}${idleMs !== null ? ` · idle: ${formatDuration(idleMs)}` : ""}`,
    "",
    "Profile",
    `  ${summary.profile.name} · ${summary.profile.model} · tools: ${summary.profile.toolCount} · auto-recall: ${summary.profile.autoRecall}`,
    `  scope: ${formatScope(summary.profile.memoryScope, opts.customCompartments, opts.restrictedClasses, summary.profile.profileClass)}`,
  ];

  // Voice mode line.
  //   - Explicit override → always surface it (even when it equals the
  //     profile default — `/voice clear` would still change semantics
  //     for any future profile-default flip, so the override is real
  //     state worth knowing about).
  //   - No override + profile default `auto` → hide; that's the
  //     unsurprising baseline and surfacing it on every `/status` adds
  //     noise without information.
  //   - No override + profile default non-auto → show as profile default.
  if (summary.voiceMode !== null) {
    if (summary.voiceMode === summary.profile.voiceMode) {
      lines.push(`  voice: ${summary.voiceMode} (override matches profile default)`);
    } else {
      lines.push(
        `  voice: ${summary.voiceMode} (override; profile default ${summary.profile.voiceMode})`,
      );
    }
  } else if (summary.profile.voiceMode !== "auto") {
    lines.push(`  voice: ${summary.profile.voiceMode} (profile default)`);
  }

  lines.push("", "Context");
  if (summary.lastTurn === null) {
    const budgetSuffix =
      summary.contextBudget === null ? "" : ` · budget: ${formatTokens(summary.contextBudget)}`;
    lines.push(`  no turns yet${budgetSuffix}`);
  } else {
    const inPart =
      summary.lastTurn.inputTokens === null
        ? "in: -"
        : `in: ${formatTokens(summary.lastTurn.inputTokens)}`;
    // outputTokens === -1 is the "unknown / pre-migration" sentinel — the
    // last assistant row was written before the column existed. Surface as
    // "-" rather than the raw number; otherwise the user sees `-1` and
    // assumes a bug.
    const outPart =
      summary.lastTurn.outputTokens < 0
        ? "out: -"
        : `out: ${formatTokens(summary.lastTurn.outputTokens)}`;
    const usagePart =
      summary.contextBudget === null || summary.lastTurn.inputTokens === null
        ? summary.contextBudget === null
          ? ""
          : ` · budget: ${formatTokens(summary.contextBudget)}`
        : ` · budget: ${formatTokens(summary.contextBudget)} (${formatPercent(summary.lastTurn.inputTokens, summary.contextBudget)})`;
    lines.push(`  last turn — ${inPart} · ${outPart}${usagePart}`);
  }

  // Steering rules + MCP fold into one line — both are small integers and
  // a dedicated section per metric would dominate the message.
  const tail: string[] = [`steering: ${summary.steeringRulesCount} rules`];
  if (summary.mcp !== null) {
    tail.push(
      `MCP: ${summary.mcp.enabledServers} servers · ${summary.mcp.approvedTools}/${summary.mcp.toolBudget} tools`,
    );
  }
  lines.push("", tail.join(" · "));

  return lines.join("\n");
}

function renderStatusFragment(summary: ConversationStatusSummary, now: Date): string {
  const c = summary.cooldownState;
  if (c === null) return "active";
  if (isInCooldown(c, now)) {
    return `cooling down (~${formatRemainingCooldown(c, now)} · ${c.consecutiveFailures} consecutive failures)`;
  }
  return `awaiting probe (${c.consecutiveFailures} consecutive failures)`;
}

function formatTokens(n: number): string {
  if (n < 1000) return String(n);
  const k = n / 1000;
  return k >= 100 ? `${Math.round(k)}k` : `${k.toFixed(1).replace(/\.0$/, "")}k`;
}

function formatPercent(used: number, budget: number): string {
  const pct = (used / budget) * 100;
  return pct < 1 ? "<1%" : `${Math.round(pct)}%`;
}

function formatDuration(ms: number): string {
  if (ms < 0) return "0s";
  const sec = Math.floor(ms / 1000);
  if (sec < 60) return `${sec}s`;
  const min = Math.floor(sec / 60);
  if (min < 60) return `${min}m`;
  const hr = Math.floor(min / 60);
  if (hr < 24) return `${hr}h`;
  const day = Math.floor(hr / 24);
  return `${day}d`;
}
