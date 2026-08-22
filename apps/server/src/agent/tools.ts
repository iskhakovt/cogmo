import { type ZodType, z } from "zod";
import { toObjectJsonSchema } from "../llm/json-schema.js";
import type { JsonSchema, ToolDefinition } from "../llm/types.js";
import { logger } from "../logger.js";
import type { Service } from "./service.js";
import { coerceToolInput } from "./tool-input-coercion.js";

/**
 * A tool handler receives validated input and scoped service.
 * Returns a string result for the LLM. Errors should be thrown —
 * the agentic loop catches and reports them as tool_result with isError.
 */
/**
 * Per-call context for one tool invocation. Distinct from {@link Service},
 * which is the per-conversation capability bundle (and the ACL boundary):
 * this carries facts about *this* call, so it can't be folded in there
 * without making a shared object per-call.
 *
 * Optional on {@link ToolHandler} by design — a handler declared
 * `(input, service)` is assignable to the three-parameter type, so tools
 * that don't need a call context are unaffected.
 */
export interface ToolCallContext {
  /**
   * Deterministic token identifying this tool call, stable across every
   * re-execution of it — step replays, and the retry that follows a crash
   * between a side effect committing and the step result being recorded.
   * Derived from durable turn state, never from anything the model mints.
   *
   * Side-effectful tools pass it to whatever DB-level idempotency their
   * domain provides (`coding_tasks.idempotency_key`,
   * `skill_runs.idempotency_key`). Absent outside a retrying context.
   */
  idempotencyKey: string;
}

export type ToolHandler = (
  input: Record<string, unknown>,
  service: Service,
  ctx?: ToolCallContext,
) => Promise<string>;

/**
 * Full tool specification — execution-environment agnostic.
 * JSON Schema is the universal contract; Zod is a convenience for TypeScript tools.
 */
export interface ToolSpec {
  name: string;
  description: string;
  inputSchema: JsonSchema;
  handler: ToolHandler;
  /**
   * Durability for this tool's handler execution.
   *
   * When `true` AND a `StepRunner` is provided to the agent loop, the handler
   * runs inside `step.run()` so it executes exactly once per turn and the
   * result replays from the Inngest step cache. Policy: **side-effectful or
   * billable ⇒ `true`.** Inngest re-invokes the whole function at every step
   * boundary on success, so a non-durable handler re-executes once per
   * remaining boundary of the turn — a DB-writing tool inserts duplicates, a
   * paid API re-bills, a non-idempotent mutation flips its recorded result.
   * Leave unset ONLY for cheap idempotent reads whose output may be large or
   * is trivially recomputed (`read_file`, `list_*`, `current_time`); their
   * persisted tool_result is whatever the last invocation returned.
   *
   * No effect when `StepRunner` is not provided (e.g. unit tests, agent loops
   * running outside Inngest). See `design/crash-recovery.md` → Tool
   * durability policy.
   */
  durable?: boolean;
  /**
   * Canonicalize raw provider arguments into the value the handler will
   * actually receive. The loop digests THIS into the call's idempotency
   * key, so a re-delivery that phrases the same request differently — a
   * nested object sent as a JSON string, a field the schema drops — still
   * yields one key rather than minting a second side effect.
   *
   * Must return the same value the handler is given for the same payload,
   * or the key stops identifying the request. {@link defineTool} guarantees
   * that by parsing once and sharing the result. A hand-built spec that
   * omits it has its raw arguments digested instead, which can only mint a
   * duplicate, never collapse two distinct requests into one.
   */
  normalizeInput?: (raw: Record<string, unknown>) => unknown;
  /**
   * Declares the handler has no ordering dependency on sibling tool calls in
   * the same turn. Consecutive parallelSafe entries in the LLM's tool_use
   * sequence run via `Promise.all`; unsafe entries run individually between
   * those groups, preserving emission order.
   *
   * Safe: read-only HTTP, independent provider calls, pure compute. Unsafe:
   * writes against shared state (core memory blocks, same file path).
   */
  parallelSafe?: boolean;
  /**
   * Declares the handler has no observable side effect on the world — pure
   * read of state the agent doesn't own (file system, web, memory, clock).
   *
   * Consumed by the Class D loop-pathology gate: an iteration whose tool
   * calls are all `sideEffectful: false` does not count as "progress", so
   * repeating the same read-only fingerprint trips the stuck-loop detector
   * (see `design/agent-resilience.md` → Class D).
   *
   * The field is **optional**, and `undefined` is treated as `true` by
   * consumers (`spec.sideEffectful ?? true`) — fail-safe, so a missing flag
   * never causes Class D to falsely trip on a tool that genuinely makes
   * progress. Tools opt in to `false` only when the handler is a pure read.
   */
  sideEffectful?: boolean;
  /**
   * Per-turn cap on how many *iterations* this tool may run in before
   * the Class D volume-cluster trigger intercepts further calls. Must
   * be a positive integer (>= 1); `defineTool` rejects 0 and negative
   * values at registration time.
   *
   * Counted regardless of per-call outcome — volume is the signal, not
   * failure rate. A successful same-tool result dilutes attention the
   * same as a failed one. Default at the consumer is
   * `DEFAULT_INVOCATION_BUDGET`; tools opt in to a different value when
   * the cost / legitimate-use shape diverges from the default
   * (image-gen 2, memory_recall 3, read_file 10, etc.).
   *
   * See `design/agent-resilience.md` → Volume cluster trigger.
   */
  invocationBudget?: number;
}

/**
 * Default per-tool invocation budget when `ToolSpec.invocationBudget` is
 * unset. Conservative fail-safe — see the section in
 * `design/agent-resilience.md` for per-tool calibration.
 */
export const DEFAULT_INVOCATION_BUDGET = 5;

/**
 * Typed helper for defining in-process TypeScript tools.
 *
 * Generates JSON Schema from Zod via z.toJSONSchema(), and wraps
 * the handler with schema.parse() for runtime input validation.
 * Validation errors are caught by the loop's try/catch and returned
 * as isError tool results — the LLM can retry with corrected input.
 */
export function defineTool<T>(opts: {
  name: string;
  description: string;
  schema: ZodType<T>;
  handler: (input: T, service: Service, ctx?: ToolCallContext) => Promise<string>;
  /** See `ToolSpec.durable`. */
  durable?: boolean;
  /** See `ToolSpec.parallelSafe`. */
  parallelSafe?: boolean;
  /** See `ToolSpec.sideEffectful`. */
  sideEffectful?: boolean;
  /** See `ToolSpec.invocationBudget`. */
  invocationBudget?: number;
}): ToolSpec {
  if (
    opts.invocationBudget !== undefined &&
    (!Number.isInteger(opts.invocationBudget) || opts.invocationBudget < 1)
  ) {
    throw new Error(
      `defineTool(${opts.name}): invocationBudget must be a positive integer (>= 1); got ${opts.invocationBudget}`,
    );
  }
  const inputSchema = toObjectJsonSchema(opts.schema);
  // One parse per raw payload, shared by `normalizeInput` (which the loop
  // digests into the call's idempotency key) and the handler wrapper. Parsing
  // twice would let a schema with a non-deterministic `.default(() => ...)`
  // or `.transform()` hand the key a different value than the handler sees —
  // and hand a retry a different key again, which is the dedup gone. Keyed on
  // the raw object's identity, which is stable for the lifetime of one
  // `runOne`; entries fall out with the payload.
  // Boxed so a schema whose output is a primitive (`.transform()` to a
  // string, say) still caches — an unboxed `undefined` miss would re-parse and
  // reopen the double-parse gap this exists to close. Keyed weakly on the raw
  // payload, which `coerceToolInput` accepts as a root-level JSON *string*
  // when a provider double-encodes the arguments; a string is not a legal
  // WeakMap key, so a non-object payload skips the cache rather than throwing.
  const parsed = new WeakMap<object, { value: T }>();
  const parseOnce = (raw: Record<string, unknown>): T => {
    const cacheable = typeof raw === "object" && raw !== null;
    const hit = cacheable ? parsed.get(raw) : undefined;
    if (hit) return hit.value;
    // Some providers occasionally serialize a nested object argument as a
    // JSON string; unwrap once before Zod so the parse error the LLM sees
    // reflects a real schema violation, not a serialization quirk.
    const { value, coercedPaths } = coerceToolInput(raw, inputSchema);
    if (coercedPaths.length > 0) {
      logger.debug({ tool: opts.name, paths: coercedPaths }, "coerced stringified tool input");
    }
    const out = opts.schema.parse(value);
    if (cacheable) parsed.set(raw, { value: out });
    return out;
  };
  return {
    name: opts.name,
    description: opts.description,
    inputSchema,
    handler: async (raw, service, ctx) => opts.handler(parseOnce(raw), service, ctx),
    // The value the handler will receive, exposed so the loop keys a call on
    // its normalized arguments rather than the raw payload.
    normalizeInput: parseOnce,
    ...(opts.durable !== undefined && { durable: opts.durable }),
    ...(opts.parallelSafe !== undefined && { parallelSafe: opts.parallelSafe }),
    ...(opts.sideEffectful !== undefined && { sideEffectful: opts.sideEffectful }),
    ...(opts.invocationBudget !== undefined && { invocationBudget: opts.invocationBudget }),
  };
}

/**
 * Registry of available tools. Maps tool name → spec.
 * The agentic loop uses this to resolve tool calls from the LLM.
 */
export class ToolRegistry {
  #tools = new Map<string, ToolSpec>();

  register(spec: ToolSpec): void {
    this.#tools.set(spec.name, spec);
  }

  get(name: string): ToolSpec | undefined {
    return this.#tools.get(name);
  }

  definitions(): ToolDefinition[] {
    return [...this.#tools.values()].map((t) => ({
      name: t.name,
      description: t.description,
      parameters: t.inputSchema,
    }));
  }

  /**
   * Return all registered specs as an array. Used by callers that need to
   * build a per-turn registry layered on top of this one (e.g. handle-message
   * adds dynamically-registered skill tools each turn).
   */
  snapshot(): readonly ToolSpec[] {
    return [...this.#tools.values()];
  }
}

/**
 * Create a registry with built-in tools.
 *
 * @param defaultTimezone IANA timezone for the current_time tool (e.g. "Europe/Moscow")
 */
export function createDefaultTools(
  extraTools: ToolSpec[] = [],
  defaultTimezone = "UTC",
): ToolRegistry {
  const registry = new ToolRegistry();

  registry.register(
    defineTool({
      name: "get_current_time",
      description:
        "Returns the current date, time, day of week, and timezone. " +
        "Use for scheduling, deadlines, or time questions. The system prompt includes the time " +
        "when the conversation started — call this tool for long-running sessions or exact time.",
      parallelSafe: true,
      sideEffectful: false,
      schema: z.object({
        timezone: z
          .string()
          .optional()
          .describe("IANA timezone name (e.g. 'America/New_York'). Defaults to user's timezone."),
      }),
      handler: async (input) => {
        const tz = input.timezone ?? defaultTimezone;
        const now = new Date();
        const formatter = new Intl.DateTimeFormat("en-US", {
          timeZone: tz,
          weekday: "long",
          year: "numeric",
          month: "long",
          day: "numeric",
          hour: "2-digit",
          minute: "2-digit",
          hour12: false,
        });
        const parts = Object.fromEntries(
          formatter.formatToParts(now).map((p) => [p.type, p.value]),
        );
        const offset = getUtcOffset(now, tz);

        return JSON.stringify({
          iso: now.toISOString(),
          date: `${parts.weekday}, ${parts.month} ${parts.day}, ${parts.year}`,
          time: `${parts.hour}:${parts.minute}`,
          dayOfWeek: parts.weekday,
          timezone: tz,
          utcOffset: offset,
        });
      },
    }),
  );

  for (const tool of extraTools) {
    registry.register(tool);
  }

  return registry;
}

function getUtcOffset(date: Date, timezone: string): string {
  const offsetStr = new Intl.DateTimeFormat("en-US", {
    timeZone: timezone,
    timeZoneName: "shortOffset",
  })
    .formatToParts(date)
    .find((p) => p.type === "timeZoneName")?.value;
  // shortOffset returns "GMT", "GMT+3", "GMT-5:30", etc.
  return offsetStr?.replace("GMT", "UTC") ?? "UTC";
}
