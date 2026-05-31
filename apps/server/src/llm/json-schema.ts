import { type ZodType, z } from "zod";
import type { JsonSchema } from "./types.js";

/**
 * Convert a Zod object schema to the project's `JsonSchema` shape.
 *
 * `z.toJSONSchema` returns Zod's JSONSchema7-flavoured union — `type` may be
 * any of `"object"`, `"array"`, `"string"`, etc. Our `JsonSchema` pins
 * `type: "object"` because tool input schemas and structured-output schemas
 * are always object-shaped. The runtime check below narrows the union; the
 * residual single-step `as JsonSchema` is structural (every other field of
 * `JsonSchema` is `[key: string]: unknown`).
 *
 * Throws if the input isn't an object schema — a programmer error at the
 * callsite, not a runtime concern.
 */
export function toObjectJsonSchema(schema: ZodType): JsonSchema {
  const out = z.toJSONSchema(schema);
  if (out.type !== "object") {
    throw new Error(`Expected object JSON schema, got type=${String(out.type)}`);
  }
  return out as JsonSchema;
}
