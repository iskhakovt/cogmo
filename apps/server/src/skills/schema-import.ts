import { err, ok, type Result } from "neverthrow";
import { match } from "ts-pattern";
import { z } from "zod";
import type { SchemaImportReply } from "./protocol.js";
import { type SkillInputs, SkillInputsSchema, type SkillIo, SkillIoSchema } from "./types.js";

/** A skill's `Input` and `Output` JSON Schemas, null for a model it does not define. */
export interface ImportedSchemas {
  inputs: SkillInputs | null;
  outputs: SkillIo | null;
}

/**
 * Why a schema import gave no schemas, on either tier: `refused` is a verdict
 * on the skill (it did not load, its dependencies did not install, a model
 * could not be described, or `Input` does not describe an object);
 * `unavailable` means the import did not run to its end (its child or
 * session could not start, crashed or timed out).
 */
export type SchemaImportError =
  | { kind: "refused"; message: string }
  | { kind: "unavailable"; message: string };

/**
 * What an import's reply says (design/skills.md → Contracts). `inputs` must be
 * an object schema; `outputs` crossed JSON as an object, so it is one, and a
 * failed parse is a bug. `fatal` reads as `describeFatal` words it.
 */
export function schemaImportResult(
  reply: SchemaImportReply,
  describeFatal: (error: string) => string,
): Result<ImportedSchemas, SchemaImportError> {
  return match(reply)
    .returnType<Result<ImportedSchemas, SchemaImportError>>()
    .with({ type: "schemas" }, ({ inputs, outputs }) => {
      const parsedInputs = inputs === null ? null : SkillInputsSchema.safeParse(inputs);
      if (parsedInputs !== null && !parsedInputs.success) {
        return err({
          kind: "refused",
          message: `Input's JSON Schema does not describe an object: ${z.prettifyError(parsedInputs.error)}`,
        });
      }
      return ok({
        inputs: parsedInputs?.data ?? null,
        outputs: outputs === null ? null : SkillIoSchema.parse(outputs),
      });
    })
    .with({ type: "schema_failed" }, ({ error }) => err({ kind: "refused", message: error }))
    .with({ type: "fatal" }, ({ error }) =>
      err({ kind: "unavailable", message: describeFatal(error) }),
    )
    .exhaustive();
}
