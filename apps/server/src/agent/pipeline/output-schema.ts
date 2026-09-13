/**
 * One way to turn a stage's declared JSON output schema into a validator,
 * shared by the definition-time check (`validateDefinition`) and the run-time
 * extraction (`extractStageArtifact`) so the two can never disagree about
 * which schemas work.
 *
 * The schema is user-shaped: the compiler model writes it, and models declare
 * `$schema` in every spelling — http or https, with or without the trailing
 * `#`. The dialect is read from that declaration (draft-07 when absent) and
 * the schema checked against its meta-schema, then compiled by the matching
 * Ajv class. Draft-07, 2019-09 and 2020-12 are supported natively. Draft-06
 * follows Ajv's documented setup: the schema is checked against the draft-06
 * meta-schema, then evaluated by the draft-07 class, so draft-07 keywords
 * (`if`/`then`/`else`) take effect in it. Draft-03 and -04 need a separate
 * Ajv package and are reported as unsupported. Nothing here throws —
 * an unknown dialect, a meta-schema violation or a `$ref` that resolves
 * nowhere all come back as a message that reads after "output schema".
 *
 * Meta-schema checks share one Ajv per dialect, which never registers a user
 * schema; compiling uses a fresh instance per call, so one schema's `$id` can
 * never collide with another's.
 *
 * `format` keywords are not enforced (no format plugin is loaded).
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
