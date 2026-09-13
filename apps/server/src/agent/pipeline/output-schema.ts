/**
 * One way to turn a stage's declared JSON output schema into a validator,
 * shared by the definition-time check (`validateDefinition`) and the run-time
 * extraction (`extractStageArtifact`) so the two can never disagree about
 * which schemas work.
 *
 * The schema is user-shaped: the compiler model writes it, and models often
 * declare `$schema` as draft 2019-09 or 2020-12. The Ajv class is picked from
 * that declaration (draft-07 otherwise). Nothing here throws — an unknown
 * dialect, a meta-schema violation or a `$ref` that resolves nowhere all come
 * back as an error message. A fresh instance per call, so one schema's `$id`
 * can never collide with another's.
 *
 * `format` keywords are not enforced (no format plugin is loaded).
 */

import { Ajv, type ValidateFunction } from "ajv";
import { Ajv2019 } from "ajv/dist/2019.js";
import { Ajv2020 } from "ajv/dist/2020.js";
import { err, ok, type Result } from "neverthrow";

const DRAFT_2019_09 = "https://json-schema.org/draft/2019-09/schema";
const DRAFT_2020_12 = "https://json-schema.org/draft/2020-12/schema";

function ajvFor(dialect: unknown): Ajv | Ajv2019 | Ajv2020 {
  const options = { allErrors: true, strict: false };
  if (typeof dialect === "string" && dialect.startsWith(DRAFT_2020_12)) {
    return new Ajv2020(options);
  }
  if (typeof dialect === "string" && dialect.startsWith(DRAFT_2019_09)) {
    return new Ajv2019(options);
  }
  return new Ajv(options);
}

export function compileOutputSchema(
  schema: Record<string, unknown>,
): Result<ValidateFunction, string> {
  try {
    const ajv = ajvFor(schema.$schema);
    if (!ajv.validateSchema(schema)) {
      const detail = ajv.errors?.map((e) => `${e.instancePath || "/"} ${e.message}`).join("; ");
      return err(`not a valid JSON Schema: ${detail ?? "unknown error"}`);
    }
    return ok(ajv.compile(schema));
  } catch (error) {
    return err(`can't be compiled: ${error instanceof Error ? error.message : String(error)}`);
  }
}
