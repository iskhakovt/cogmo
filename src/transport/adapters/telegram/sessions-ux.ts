/**
 * Pure render helpers for Telegram /sessions and /profile lists.
 *
 * Returns a neutral shape (text + optional inline keyboard buttons) so tests
 * don't need grammY; the adapter wires the buttons to an `InlineKeyboard`.
 */

import type { ConversationSummary, Profile } from "../../../agent/store/index.js";
import { truncate } from "../../../util/string.js";

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
  opts: { currentProfileId?: string | undefined } = {},
): RenderedList {
  if (profiles.length === 0) {
    return { text: "No profiles available." };
  }
  const lines = profiles.map((p) => {
    const owner = p.userId === null ? "org" : "you";
    const current = p.id === opts.currentProfileId ? " ← current" : "";
    // Memory scope is null for most profiles (unrestricted) — only annotate
    // when set, so the common case stays compact.
    const scope = p.memoryScope
      ? ` [scope: ${p.memoryScope.compartments.join(",")} / ${p.memoryScope.trust.join(",")}]`
      : "";
    return `• ${p.name} (${owner}, ${p.model})${scope}${current}`;
  });
  return { text: lines.join("\n") };
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
