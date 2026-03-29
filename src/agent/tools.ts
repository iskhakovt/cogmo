import { type ZodType, z } from "zod";
import type { JsonSchema, ToolDefinition } from "../llm/types.js";
import type { Service } from "./service.js";

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
}): ToolSpec {
  const inputSchema = z.toJSONSchema(opts.schema) as unknown as JsonSchema;
  return {
    name: opts.name,
    description: opts.description,
    inputSchema,
    handler: async (raw, service) => {
      const parsed = opts.schema.parse(raw);
      return opts.handler(parsed, service);
    },
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
}

/**
 * Create a registry with built-in tools.
 */
export function createDefaultTools(extraTools: ToolSpec[] = []): ToolRegistry {
  const registry = new ToolRegistry();

  registry.register(
    defineTool({
      name: "get_current_time",
      description: "Returns the current date and time in ISO 8601 format.",
      schema: z.object({}),
      handler: async () => new Date().toISOString(),
    }),
  );

  for (const tool of extraTools) {
    registry.register(tool);
  }

  return registry;
}
