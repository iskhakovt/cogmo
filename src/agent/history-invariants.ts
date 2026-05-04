/**
 * Pre-flight sanitizer for the LLM message-array contract.
 *
 * Anthropic's API rejects history that violates any of:
 * - every assistant `tool_use` block must be answered by a `tool_result` block
 *   in the next user message;
 * - `tool_result` blocks must reference a prior `tool_use` (no strays);
 * - messages must have non-empty content.
 *
 * Historical bugs in our agent loop have produced orphan `tool_use` rows in
 * the `messages` table, and any subsequent turn loaded that history and got a
 * 400 from Anthropic. This validator runs at agent-loop entry, repairs the
 * known violation classes, and returns a list of repairs so callers can log /
 * emit telemetry.
 *
 * Pure function — does not mutate input.
 */

import type { ContentBlock, Message, ToolResultBlock, ToolUseBlock } from "../llm/types.js";

/**
 * Discriminated union — `toolUseId` is required exactly when the kind is
 * one of the tool-pair repairs, absent for empty-message drops. Lifts the
 * "this id is meaningful here" invariant from a runtime convention into a
 * compile-time check.
 */
export type Repair =
  | { kind: "synthesized_tool_result"; index: number; toolUseId: string }
  | { kind: "dropped_stray_tool_result"; index: number; toolUseId: string }
  | { kind: "dropped_empty_message"; index: number };

export type RepairKind = Repair["kind"];

export interface ValidationResult {
  messages: Message[];
  repairs: Repair[];
}

const SYNTHESIZED_TOOL_RESULT_CONTENT = "tool execution did not complete (recovered)";

/**
 * Returns true if `content` is empty enough that the API will reject the message.
 * Empty string, empty array, or array containing only blocks that we strip
 * during repair (currently only stray tool_results, handled separately).
 */
function isEmptyContent(content: Message["content"]): boolean {
  return content.length === 0;
}

function toolUseIdsIn(content: Message["content"]): string[] {
  if (typeof content === "string") return [];
  return content.filter((b): b is ToolUseBlock => b.type === "tool_use").map((b) => b.id);
}

function toolResultIdsIn(content: Message["content"]): Set<string> {
  if (typeof content === "string") return new Set();
  return new Set(
    content.filter((b): b is ToolResultBlock => b.type === "tool_result").map((b) => b.toolUseId),
  );
}

function synthesizeToolResults(missingIds: ReadonlyArray<string>): ToolResultBlock[] {
  return missingIds.map((id) => ({
    type: "tool_result",
    toolUseId: id,
    content: SYNTHESIZED_TOOL_RESULT_CONTENT,
    isError: true,
  }));
}

/**
 * Sanitize a message history against the API contract.
 *
 * Repairs:
 * - **orphan tool_use** — assistant emits `tool_use` block(s) but the next
 *   user message doesn't answer them all. The synthesized `tool_result`(s)
 *   are prepended to the existing next user message, or inserted as a new
 *   user message when no answering message exists (assistant is last, or
 *   followed by another assistant).
 * - **stray tool_result** — user emits a `tool_result` referencing a
 *   `tool_use` that doesn't exist in any prior assistant message. Block is
 *   dropped; if it was the only content, the whole message is dropped.
 * - **empty content** — message has empty string or empty array. Dropped.
 *
 * Caller is responsible for logging / telemetry on the returned `repairs`
 * list.
 */
export function validateHistory(messages: ReadonlyArray<Message>): ValidationResult {
  const out: Message[] = [];
  const repairs: Repair[] = [];
  /** ids of every tool_use seen in `out` so far — used to detect stray tool_results */
  const seenToolUseIds = new Set<string>();
  /** indices in `out` we've already merged synthesized tool_results into */
  let i = 0;

  while (i < messages.length) {
    const msg = messages[i];
    if (!msg) break;

    if (isEmptyContent(msg.content)) {
      repairs.push({ kind: "dropped_empty_message", index: i });
      i++;
      continue;
    }

    if (msg.role === "user" && Array.isArray(msg.content)) {
      const cleanedBlocks: ContentBlock[] = [];
      for (const block of msg.content) {
        if (block.type === "tool_result" && !seenToolUseIds.has(block.toolUseId)) {
          repairs.push({
            kind: "dropped_stray_tool_result",
            index: i,
            toolUseId: block.toolUseId,
          });
          continue;
        }
        cleanedBlocks.push(block);
      }
      if (cleanedBlocks.length === 0) {
        repairs.push({ kind: "dropped_empty_message", index: i });
        i++;
        continue;
      }
      out.push({ role: "user", content: cleanedBlocks });
      i++;
      continue;
    }

    // Assistant message (or any user message with string content) — push as-is,
    // then handle orphan tool_use closure below if applicable.
    out.push(msg);

    if (msg.role === "assistant" && Array.isArray(msg.content)) {
      const openIds = toolUseIdsIn(msg.content);
      for (const id of openIds) seenToolUseIds.add(id);

      if (openIds.length > 0) {
        const nextMsg = messages[i + 1];
        const nextIsUser = nextMsg !== undefined && nextMsg.role === "user";
        const nextContent: ContentBlock[] = nextIsUser
          ? Array.isArray(nextMsg.content)
            ? nextMsg.content
            : nextMsg.content.length > 0
              ? [{ type: "text", text: nextMsg.content }]
              : []
          : [];
        const answered = nextIsUser ? toolResultIdsIn(nextContent) : new Set<string>();
        const missingIds = openIds.filter((id) => !answered.has(id));

        if (missingIds.length > 0) {
          for (const id of missingIds) {
            repairs.push({ kind: "synthesized_tool_result", index: i, toolUseId: id });
          }
          const synthesized = synthesizeToolResults(missingIds);

          if (nextIsUser) {
            // Drop strays from the existing user message, prepend synthesized
            // tool_results, then push it. Skip i+1 in the next loop step.
            const existingValid = nextContent.filter((b) => {
              if (b.type === "tool_result" && !seenToolUseIds.has(b.toolUseId)) {
                repairs.push({
                  kind: "dropped_stray_tool_result",
                  index: i + 1,
                  toolUseId: b.toolUseId,
                });
                return false;
              }
              return true;
            });
            const merged: ContentBlock[] = [...synthesized, ...existingValid];
            out.push({ role: "user", content: merged });
            i += 2;
            continue;
          }

          // No answering user message exists — insert a fresh one carrying
          // only the synthesized tool_results.
          out.push({ role: "user", content: synthesized });
        }
      }
    }
    i++;
  }

  return { messages: out, repairs };
}
