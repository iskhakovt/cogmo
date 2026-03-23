import type { JsonSchema, ToolDefinition } from "../llm/types.js";

/**
 * A tool handler receives parsed input and returns a string result.
 * Errors should be thrown — the agentic loop catches and reports them.
 */
export type ToolHandler = (input: Record<string, unknown>) => Promise<string>;

/**
 * Full tool specification: definition (sent to LLM) + handler (executed locally).
 */
export interface ToolSpec {
  definition: ToolDefinition;
  handler: ToolHandler;
}

/**
 * Registry of available tools. Maps tool name → spec.
 * The agentic loop uses this to resolve tool calls from the LLM.
 */
export class ToolRegistry {
  private readonly tools = new Map<string, ToolSpec>();

  register(name: string, description: string, parameters: JsonSchema, handler: ToolHandler): void {
    this.tools.set(name, {
      definition: { name, description, parameters },
      handler,
    });
  }

  get(name: string): ToolSpec | undefined {
    return this.tools.get(name);
  }

  definitions(): ToolDefinition[] {
    return [...this.tools.values()].map((t) => t.definition);
  }
}

/**
 * Create a registry with built-in test tools for verifying the agentic loop.
 */
export function createDefaultTools(): ToolRegistry {
  const registry = new ToolRegistry();

  registry.register(
    "get_current_time",
    "Returns the current date and time in ISO 8601 format.",
    { type: "object", properties: {}, required: [] },
    async () => new Date().toISOString(),
  );

  return registry;
}
