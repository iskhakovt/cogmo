import { type ZodType, z } from "zod";
import type { JsonSchema, ToolDefinition } from "../llm/types.js";
import { logger } from "../logger.js";
import type { Service } from "./service.js";
import { coerceToolInput } from "./tool-input-coercion.js";

/**
 * A tool handler receives validated input and scoped service.
 * Returns a string result for the LLM. Errors should be thrown —
 * the agentic loop catches and reports them as tool_result with isError.
 */
export type ToolHandler = (input: Record<string, unknown>, service: Service) => Promise<string>;

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
   * Opt-in durability for this tool's handler execution.
   *
   * When `true` AND a `StepRunner` is provided to the agent loop, the handler
   * runs inside `step.run()` so the result is cached exactly-once across
   * Inngest retries. Intended for expensive or billable side effects
   * (image generation, paid web search, etc.) where re-execution on retry
   * would re-bill or re-upload. Cheap/idempotent tools (memory reads, time,
   * file I/O) should leave this unset — retrying them is free and avoids
   * the overhead of a step state entry.
   *
   * No effect when `StepRunner` is not provided (e.g. unit tests, agent loops
   * running outside Inngest). See `design/crash-recovery.md`.
   */
  durable?: boolean;
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
}

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
  handler: (input: T, service: Service) => Promise<string>;
  /** See `ToolSpec.durable`. */
  durable?: boolean;
  /** See `ToolSpec.parallelSafe`. */
  parallelSafe?: boolean;
}): ToolSpec {
  // z.toJSONSchema returns Zod's JSONSchema7-flavoured shape; our internal
  // JsonSchema type is a narrower subset that the LLM providers accept.
  const inputSchema = z.toJSONSchema(opts.schema) as unknown as JsonSchema;
  return {
    name: opts.name,
    description: opts.description,
    inputSchema,
    handler: async (raw, service) => {
      // Some providers occasionally serialize a nested object argument as a
      // JSON string; unwrap once before Zod so the parse error the LLM sees
      // reflects a real schema violation, not a serialization quirk.
      const { value, coercedPaths } = coerceToolInput(raw, inputSchema);
      if (coercedPaths.length > 0) {
        logger.debug({ tool: opts.name, paths: coercedPaths }, "coerced stringified tool input");
      }
      const parsed = opts.schema.parse(value);
      return opts.handler(parsed, service);
    },
    ...(opts.durable !== undefined && { durable: opts.durable }),
    ...(opts.parallelSafe !== undefined && { parallelSafe: opts.parallelSafe }),
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
