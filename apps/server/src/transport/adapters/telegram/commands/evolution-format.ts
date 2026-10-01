/** Rendering of evolution events for `/learned`. */

import type { ObserverPhase } from "../../../../agent/evolution/index.js";
import type { EvolutionEventEntry } from "../../../transport.js";

/**
 * Render the `/learned` digest — one line per event, newest first. Entries
 * stay short so a 10-event list fits well under Telegram's 4096-char
 * message cap with room for the header.
 */
export function formatEvolutionDigest(
  events: ReadonlyArray<EvolutionEventEntry>,
  now: Date = new Date(),
): string {
  const header = `Evolution events (${events.length}):`;
  const lines = events.map((e, i) => {
    const c = e.payload.corrections;
    const m = e.payload.memories;
    const ruleDelta = c.extracted + c.reinforced + c.promoted + c.retired + c.reset;
    const memoryDelta = m.extracted;
    const withheld = e.payload.drained.withheld;
    const deferred = e.payload.drained.deferredToFirstParty;
    const withheldNote =
      (withheld > 0 ? `, ${withheld} withheld` : "") +
      (deferred > 0 ? `, ${deferred} deferred` : "");
    const tag = e.triggeredBy === "manual" ? " [manual]" : "";
    const failed = e.payload.failedPhases ?? [];
    const failedNote = failed.length > 0 ? `; failed: ${failed.join(", ")}` : "";
    return (
      `${i + 1}. ${e.id}${tag}\n` +
      `   ${formatRelativeTime(e.createdAt, now)} — ${ruleDelta} rule change(s), ${memoryDelta} memory write(s)${withheldNote}${failedNote}`
    );
  });
  return [header, ...lines].join("\n");
}

/** False on an older row, which recorded no phase outcomes. */
function phaseFailed(event: EvolutionEventEntry, phase: ObserverPhase): boolean {
  return event.payload.failedPhases?.includes(phase) === true;
}

const PHASE_FAILED = "failed after retries";

/**
 * Render `/learned <id>` — full breakdown of one event. Mirrors the
 * structured-log fields the Observer emits per fire so the operator can
 * cross-reference against process logs when debugging.
 */
export function formatEvolutionDetail(event: EvolutionEventEntry, now: Date = new Date()): string {
  const { payload } = event;
  // Reinforcements the extraction skipped: none counts in `reinforced`.
  const skipped =
    payload.corrections.outOfScopeReinforcementsSkipped +
    payload.corrections.unknownRuleReinforcementsSkipped;
  const lines: string[] = [
    `Event ${event.id}`,
    // Both forms: relative for at-a-glance scanning, ISO for log-grep parity.
    `When: ${formatRelativeTime(event.createdAt, now)} (${event.createdAt.toISOString()})`,
    `Triggered by: ${event.triggeredBy}`,
    `Conversation: ${event.conversationId}`,
    `Profile: ${payload.profileId}`,
    `Transcript: ${payload.messageCount} message(s)`,
  ];
  if (payload.durationMs !== undefined) {
    lines.push(`Took: ${formatDurationMs(payload.durationMs)}`);
  }
  // A failed phase's counts are fallback zeros, not findings.
  if (phaseFailed(event, "corrections")) {
    lines.push("", `Corrections: ${PHASE_FAILED}`);
  } else {
    lines.push(
      "",
      "Corrections:",
      `  extracted:    ${payload.corrections.extracted}`,
      `  reinforced:   ${payload.corrections.reinforced}`,
      `  promoted:     ${payload.corrections.promoted}`,
      `  contradicted: ${payload.corrections.contradictions}`,
    );
    // Each is a part of `contradicted`: a first contradiction resets, a second retires.
    if (payload.corrections.retired > 0) {
      lines.push(`  retired:      ${payload.corrections.retired} (learning, contradicted twice)`);
    }
    if (payload.corrections.reset > 0) {
      lines.push(`  reset:        ${payload.corrections.reset} (learning, contradicted once)`);
    }
    if (payload.corrections.outOfScopeContradictionsSkipped > 0) {
      lines.push(
        `  not applied:  ${payload.corrections.outOfScopeContradictionsSkipped} (learning, on another channel)`,
      );
    }
  }
  // Surface the skipped counters only when non-zero — they're zero on
  // most fires and the silence is the signal. When something WAS
  // skipped, the operator wants to see it spelled out so they can
  // reconcile against `extracted + reinforced`. Pre-computed total
  // gates the whole block so a "0 skipped" line never adds noise.
  if (skipped > 0) {
    lines.push(
      `  skipped:      ${skipped} reinforcement(s) (${payload.corrections.outOfScopeReinforcementsSkipped} out-of-scope, ${payload.corrections.unknownRuleReinforcementsSkipped} unknown-rule)`,
    );
  }
  if (phaseFailed(event, "consolidation")) {
    lines.push("", `Consolidation: ${PHASE_FAILED}`);
  } else if (payload.consolidation) {
    lines.push("", "Consolidation:");
    lines.push(`  merged groups: ${payload.consolidation.mergedGroups}`);
    lines.push(`  rules removed: ${payload.consolidation.rulesRemoved}`);
  }
  if (phaseFailed(event, "memories")) {
    lines.push("", `Memories: ${PHASE_FAILED}`);
  } else if (payload.memories.skippedForUnseenRules > 0) {
    lines.push(
      "",
      "Memories: skipped; a user's memory rule binds it and this profile can't see it",
    );
  } else {
    lines.push("", `Memories: ${payload.memories.extracted} extracted`);
    for (const [network, count] of Object.entries(payload.memories.byNetwork)) {
      lines.push(`  ${network}: ${count}`);
    }
  }
  const { deferredToFirstParty } = payload.drained;
  if (phaseFailed(event, "drain")) {
    lines.push("", `Pending drain: ${PHASE_FAILED}; undrained rows stay pending`);
  } else if (
    payload.drained.drained > 0 ||
    payload.drained.withheld > 0 ||
    deferredToFirstParty > 0
  ) {
    lines.push("", `Pending drained: ${payload.drained.drained}`);
    for (const [network, count] of Object.entries(payload.drained.byNetwork)) {
      lines.push(`  ${network}: ${count}`);
    }
    if (payload.drained.withheld > 0) {
      lines.push(`  withheld by a memory rule: ${payload.drained.withheld}`);
    }
    if (deferredToFirstParty > 0) {
      lines.push(`  deferred to a first-party fire: ${deferredToFirstParty}`);
    }
  }
  return lines.join("\n");
}

/**
 * Format a past instant as a short human-readable delta from `now`.
 * Optimised for at-a-glance scanning in chat. Delegates the formatting
 * to `Intl.RelativeTimeFormat` (built-in, Node ≥18) so the strings
 * follow locale conventions ("yesterday" / "5 minutes ago"). The Intl
 * API can't pick the "best" unit itself — caller still chooses
 * seconds/minutes/hours/days — but everything past unit selection
 * (pluralisation, "yesterday" vs "1 day ago", negative sign placement)
 * is handled by the platform.
 *
 * Older than a week → fall back to an ISO date stamp. Future
 * timestamps work too (Intl produces "in 5 minutes" etc.); a future
 * `createdAt` would be a stamping bug, but the renderer shouldn't
 * crash on it.
 *
 * Exported so unit tests can pin `now` deterministically.
 */
const RELATIVE_TIME_FORMAT = new Intl.RelativeTimeFormat("en", { numeric: "auto" });

export function formatRelativeTime(when: Date, now: Date): string {
  // Negative delta = past, positive = future; `RelativeTimeFormat`
  // matches that sign convention.
  const deltaSec = (when.getTime() - now.getTime()) / 1000;
  const absSec = Math.abs(deltaSec);
  if (absSec < 45) return RELATIVE_TIME_FORMAT.format(0, "second");
  const min = deltaSec / 60;
  if (Math.abs(min) < 60) return RELATIVE_TIME_FORMAT.format(Math.round(min), "minute");
  const hr = min / 60;
  if (Math.abs(hr) < 24) return RELATIVE_TIME_FORMAT.format(Math.round(hr), "hour");
  const day = hr / 24;
  if (Math.abs(day) < 7) return RELATIVE_TIME_FORMAT.format(Math.round(day), "day");
  // Anything older than a week is calendar-scale; a relative phrase
  // ("3 weeks ago") loses too much resolution for an audit log. ISO
  // date stamp keeps grep parity with structured logs.
  return when.toISOString().slice(0, 10);
}

/**
 * Compact ms → human duration. Uses `Intl.DurationFormat` (Node ≥22)
 * with `style: "narrow"` ("1m 32s") and trims to the largest two
 * relevant units. Sub-second values stay raw ms because the Intl
 * variant collapses them to "0 seconds".
 */
const DURATION_FORMAT = new Intl.DurationFormat("en", { style: "narrow" });

function formatDurationMs(ms: number): string {
  if (ms < 1000) return `${ms}ms`;
  const totalSec = Math.round(ms / 1000);
  const min = Math.floor(totalSec / 60);
  const sec = totalSec % 60;
  if (min === 0) return DURATION_FORMAT.format({ seconds: sec });
  return DURATION_FORMAT.format(sec === 0 ? { minutes: min } : { minutes: min, seconds: sec });
}
