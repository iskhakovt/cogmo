/**
 * One path from a stage's declared JSON output schema to a validator, shared
 * by the definition check (`validateDefinition`) and run-time extraction
 * (`extractStageArtifact`) so the two accept exactly the same schemas.
 *
 * The dialect comes from `$schema` in any http/https or trailing-`#` spelling,
 * draft-07 when absent. Draft-07, 2019-09 and 2020-12 compile natively;
 * draft-06 is checked against its own meta-schema and runs on the draft-07
 * class, Ajv's documented setup. Draft-03/04 are unsupported. The schema must
 * describe an object (artifacts are stored as one) and must not be `$async`
 * (callers validate synchronously). Nothing throws: every failure is a
 * message that reads after "output schema".
 *
 * Meta-schema checks share one Ajv per dialect, which never registers a user
 * schema; each compile gets a fresh instance, so `$id`s never collide.
 * `format` keywords are advisory (no format plugin).
 */

import { Ajv, type ValidateFunction } from "ajv";
import { Ajv2019 } from "ajv/dist/2019.js";
import { Ajv2020 } from "ajv/dist/2020.js";
import draft06MetaSchema from "ajv/dist/refs/json-schema-draft-06.json" with { type: "json" };
import { err, ok, type Result } from "neverthrow";

type Dialect = "draft-06" | "draft-07" | "2019-09" | "2020-12";

/** The `$schema` URI each dialect's Ajv meta-schema is registered under. */
const CANONICAL_URI: Record<Dialect, string> = {
  "draft-06": "http://json-schema.org/draft-06/schema#",
  "draft-07": "http://json-schema.org/draft-07/schema#",
  "2019-09": "https://json-schema.org/draft/2019-09/schema",
  "2020-12": "https://json-schema.org/draft/2020-12/schema",
};

const DIALECT_URI =
  /^https?:\/\/json-schema\.org\/(draft-0[34]|draft-0[67]|draft\/2019-09|draft\/2020-12)\/schema#?$/;

type DialectMatch =
  | { kind: "dialect"; dialect: Dialect }
  | { kind: "unsupported"; name: string }
  | { kind: "unknown" };

function readDialect(declared: unknown): DialectMatch {
  if (declared === undefined) return { kind: "dialect", dialect: "draft-07" };
  const name = typeof declared === "string" ? DIALECT_URI.exec(declared)?.[1] : undefined;
  switch (name) {
    case "draft-06":
    case "draft-07":
      return { kind: "dialect", dialect: name };
    case "draft/2019-09":
      return { kind: "dialect", dialect: "2019-09" };
    case "draft/2020-12":
      return { kind: "dialect", dialect: "2020-12" };
    case undefined:
      return { kind: "unknown" };
    default:
      return { kind: "unsupported", name };
  }
}

function createAjv(dialect: Dialect, validateSchema: boolean): Ajv | Ajv2019 | Ajv2020 {
  const options = { allErrors: true, strict: false, validateSchema };
  switch (dialect) {
    case "2020-12":
      return new Ajv2020(options);
    case "2019-09":
      return new Ajv2019(options);
    case "draft-07":
      return new Ajv(options);
    case "draft-06": {
      const ajv = new Ajv(options);
      ajv.addMetaSchema(draft06MetaSchema);
      return ajv;
    }
  }
}

const metaValidators = new Map<Dialect, Ajv | Ajv2019 | Ajv2020>();

function metaValidator(dialect: Dialect): Ajv | Ajv2019 | Ajv2020 {
  const cached = metaValidators.get(dialect);
  if (cached !== undefined) return cached;
  const ajv = createAjv(dialect, true);
  metaValidators.set(dialect, ajv);
  return ajv;
}

export function compileOutputSchema(
  schema: Record<string, unknown>,
): Result<ValidateFunction, string> {
  const match = readDialect(schema.$schema);
  if (match.kind === "unsupported") {
    return err(`declares JSON Schema ${match.name}, which isn't supported — use draft-06 or later`);
  }
  if (match.kind === "unknown") {
    return err(`declares an unknown $schema ${JSON.stringify(schema.$schema)}`);
  }
  if (schema.type !== "object") {
    return err(`must have top-level "type": "object", got ${JSON.stringify(schema.type)}`);
  }
  // Ajv compiles an async validator exactly when the root declares `$async`.
  if (schema.$async === true) {
    return err("is an $async schema, which isn't supported — validation must be synchronous");
  }
  const normalised = { ...schema, $schema: CANONICAL_URI[match.dialect] };
  try {
    const meta = metaValidator(match.dialect);
    if (!meta.validateSchema(normalised)) {
      const detail = meta.errors?.map((e) => `${e.instancePath || "/"} ${e.message}`).join("; ");
      return err(`is not a valid JSON Schema: ${detail ?? "unknown error"}`);
    }
    return ok(createAjv(match.dialect, false).compile(normalised));
  } catch (error) {
    return err(`can't be compiled: ${error instanceof Error ? error.message : String(error)}`);
  }
}
