/**
 * Pure renderer for the per-task progress message Cogmo edits in place.
 *
 * Format (matches design/coding-delegation.md → Progress UX):
 *
 *   <header line: phase emoji + goal preview>
 *   <status line: phase verb + token counter>
 *   <last activity line — execute phase only>
 *
 *   <body — plan text or execute narration>
 *
 * Body and the activity line are optional; the formatter omits empty
 * sections rather than rendering empty placeholders. Output is plain
 * Telegram-safe text (no Markdown / HTML — escaping is the adapter's
 * responsibility on send).
 */

export type ProgressPhase =
  | "planning"
  | "awaiting_approval"
  | "executing"
  | "pending_verify"
  | "failed"
  | "cancelled";

export interface ProgressTokenCounter {
  input: number;
  output: number;
}

export interface ProgressFormatInput {
  goal: string;
  phase: ProgressPhase;
  /** Plan body (plan phase) or accumulated execute narration. */
  body: string;
  /** Last tool the CLI invoked / its result, e.g. "Read foo.ts". Execute only. */
  lastActivity?: string;
  /** Token counter — undefined until the result event lands. */
  tokens?: ProgressTokenCounter;
  /** Failure reason — used only when phase = failed / cancelled. */
  failureReason?: string;
}

const PHASE_HEADER: Record<ProgressPhase, string> = {
  planning: "🧠 Planning",
  awaiting_approval: "📋 Plan ready — awaiting approval",
  executing: "⚙️ Executing",
  // Claude has finished but verify hasn't run (slice 4 ships
  // verify+push+PR). Label avoids "done" / green-check imagery so the
  // user doesn't mistake `pending_verify` for task success — it's a
  // non-terminal state.
  pending_verify: "🛠 Execute done — awaiting verify",
  failed: "❌ Failed",
  cancelled: "🚫 Cancelled",
};

/** Telegram messages cap at 4096 chars; cap the body somewhat below to leave headroom for headers. */
const MAX_BODY_CHARS = 3500;
const GOAL_PREVIEW_CHARS = 80;

export function formatProgressMessage(input: ProgressFormatInput): string {
  const lines: string[] = [];

  const goalPreview =
    input.goal.length > GOAL_PREVIEW_CHARS
      ? `${input.goal.slice(0, GOAL_PREVIEW_CHARS - 1)}…`
      : input.goal;
  lines.push(`${PHASE_HEADER[input.phase]} — ${goalPreview}`);

  const statusBits: string[] = [];
  if (input.tokens) {
    const sum = input.tokens.input + input.tokens.output;
    statusBits.push(
      `${sum.toLocaleString()} tokens (in ${input.tokens.input.toLocaleString()} / out ${input.tokens.output.toLocaleString()})`,
    );
  }
  if (input.failureReason && (input.phase === "failed" || input.phase === "cancelled")) {
    statusBits.push(input.failureReason);
  }
  if (statusBits.length > 0) lines.push(statusBits.join(" · "));

  if (input.lastActivity && input.phase === "executing") {
    lines.push(`↻ ${input.lastActivity}`);
  }

  const body = truncateBody(input.body);
  if (body) {
    lines.push("");
    lines.push(body);
  }

  return lines.join("\n");
}

/**
 * Cap the body at MAX_BODY_CHARS, replacing the head (older content) with
 * a `…` marker. Tail is the freshest narration — keeping that is more
 * useful than keeping the start of a long execute log.
 */
function truncateBody(body: string): string {
  if (body.length <= MAX_BODY_CHARS) return body;
  const cut = body.length - MAX_BODY_CHARS + 3; // +3 for "…\n\n"
  // Prefer cutting at a newline so we don't leave a half-word at the seam.
  const seam = body.indexOf("\n", cut);
  const start = seam === -1 ? cut : seam + 1;
  return `…\n\n${body.slice(start)}`;
}

/**
 * Render the activity line for a tool_call event. Format intentionally
 * terse — appears as a single line of progress.
 */
export function describeToolCall(tool: string): string {
  return `${tool}…`;
}

export function describeToolResult(tool: string, ok: boolean, summary?: string): string {
  const tail = summary ? ` — ${truncateInline(summary, 60)}` : "";
  return `${tool} ${ok ? "✓" : "✗"}${tail}`;
}

function truncateInline(s: string, max: number): string {
  const oneLine = s.replace(/\s+/g, " ").trim();
  return oneLine.length > max ? `${oneLine.slice(0, max - 1)}…` : oneLine;
}
