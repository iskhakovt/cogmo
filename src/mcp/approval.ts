import { createHash } from "node:crypto";
import type { McpToolDescriptor, McpToolPin, ToolSchemaSnapshot } from "./config.js";

/**
 * Stable SHA-256 of `{description, inputSchema}`. Object keys are recursively
 * sorted before stringification so two semantically-equal snapshots that differ
 * only in JSON property ordering hash identically. Used for schema-pinning and
 * rug-pull detection: a tool whose description or input schema changes after
 * approval flips back to `pending` and stops surfacing to the agent.
 */
export function hashToolSchema(snapshot: ToolSchemaSnapshot): string {
  const canonical = JSON.stringify(canonicalize(snapshot));
  return createHash("sha256").update(canonical).digest("hex");
}

function canonicalize(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(canonicalize);
  if (value !== null && typeof value === "object") {
    const sorted: Record<string, unknown> = {};
    for (const k of Object.keys(value as Record<string, unknown>).sort()) {
      sorted[k] = canonicalize((value as Record<string, unknown>)[k]);
    }
    return sorted;
  }
  return value;
}

export interface PinDiff {
  /** Tools the server now exposes but we have no pin for. */
  added: readonly McpToolDescriptor[];
  /** Pinned tool names the server no longer exposes. */
  removed: readonly string[];
  /** Tools whose description or schema changed since the pin was made. */
  mutated: ReadonlyArray<{ tool: McpToolDescriptor; pin: McpToolPin }>;
  /** Tools whose pin is still byte-identical to what the server reports. */
  unchanged: readonly McpToolPin[];
}

/**
 * Diff a fresh `listTools()` against persisted pins. Pure function — no DB
 * writes; the caller decides how to apply the diff (typically: upsert added
 * + mutated as `pending`, delete removed, leave unchanged alone).
 */
export function diffPins(
  current: readonly McpToolDescriptor[],
  pinned: readonly McpToolPin[],
): PinDiff {
  const pinsByName = new Map(pinned.map((p) => [p.toolName, p]));
  const currentByName = new Map(current.map((t) => [t.name, t]));

  const added: McpToolDescriptor[] = [];
  const mutated: { tool: McpToolDescriptor; pin: McpToolPin }[] = [];
  const unchanged: McpToolPin[] = [];

  for (const tool of current) {
    const pin = pinsByName.get(tool.name);
    if (!pin) {
      added.push(tool);
      continue;
    }
    const newHash = hashToolSchema({
      description: tool.description,
      inputSchema: tool.inputSchema,
    });
    if (newHash !== pin.schemaHash) {
      mutated.push({ tool, pin });
    } else {
      unchanged.push(pin);
    }
  }

  const removed = pinned.filter((p) => !currentByName.has(p.toolName)).map((p) => p.toolName);

  return { added, removed, mutated, unchanged };
}
