/**
 * Convert an agentic stage's final reply into the typed artifact its
 * envelope declares. `text` is the reply itself. `json` is one tools-free
 * structured-output call against the compiler-emitted JSON Schema, checked
 * with ajv, retried once with the validation errors fed back — the same
 * repair shape as `chatTyped`, which can't be used directly because the
 * schema here is user-shaped JSON Schema, not a Zod type.
 *
 * The agent loop itself can't produce the JSON: `responseFormat` is mutually
 * exclusive with tools, and a stage that uses tools needs them until its
 * last iteration.
 */

import { Ajv } from "ajv";
import { err, ok, type Result } from "neverthrow";
import type { LlmProvider } from "../../llm/provider.js";
import type { Message } from "../../llm/types.js";
import type { StageArtifact } from "./run-types.js";
import type { StageOutput } from "./types.js";

const ajv = new Ajv({ allErrors: true, strict: false });

/** One initial attempt plus this many feedback retries. */
const JSON_ARTIFACT_RETRIES = 1;

export interface ArtifactExtractionError {
  kind: "artifact_invalid";
  detail: string;
}

export async function extractStageArtifact(args: {
  output: StageOutput | undefined;
  finalText: string;
  provider: LlmProvider;
  model: string;
  stageId: string;
}): Promise<Result<StageArtifact | null, ArtifactExtractionError>> {
  const { output, finalText } = args;
  if (output === undefined) return ok(null);
  if (output.kind === "text") return ok({ kind: "text", text: finalText });
  if (output.kind !== "json") {
    // Rejected before the run starts (see `findUnsupportedFeatures`); reaching
    // here means a caller skipped that check.
    return err({ kind: "artifact_invalid", detail: `unsupported output kind "${output.kind}"` });
  }

  // Structured output takes an object schema at the top level. The compiler
  // accepts any meta-schema-valid schema, so a non-object one is a definition
  // this stage can never satisfy — fail it with the reason rather than send a
  // request the provider rejects.
  if (output.schema.type !== "object") {
    return err({
      kind: "artifact_invalid",
      detail: `output schema must have top-level "type": "object", got ${JSON.stringify(output.schema.type)}`,
    });
  }
  const schema = { ...output.schema, type: "object" as const };
  const validate = ajv.compile(schema);
  const messages: Message[] = [
    {
      role: "user",
      content: `Convert this pipeline stage result into JSON matching the required schema. Use only information present in the result.\n\n<result>\n${finalText}\n</result>`,
    },
  ];

  let lastDetail = "";
  for (let attempt = 0; attempt <= JSON_ARTIFACT_RETRIES; attempt++) {
    const response = await args.provider.chat({
      model: args.model,
      system: "You extract structured data from text. Reply with the JSON object only.",
      messages,
      responseFormat: {
        type: "json_schema",
        name: `stage_${args.stageId.replaceAll("-", "_")}`,
        schema,
      },
    });
    const text = response.content.flatMap((b) => (b.type === "text" ? [b.text] : [])).join("");

    const parsed = parseObject(text);
    if (parsed === null) {
      lastDetail = "reply was not a JSON object";
    } else if (validate(parsed)) {
      return ok({ kind: "json", value: parsed });
    } else {
      lastDetail = (validate.errors ?? [])
        .map((e) => `${e.instancePath || "/"} ${e.message ?? "is invalid"}`)
        .join("; ");
    }
    messages.push(
      { role: "assistant", content: text },
      {
        role: "user",
        content: `That JSON does not match the schema: ${lastDetail}. Reply with a corrected JSON object only.`,
      },
    );
  }
  return err({ kind: "artifact_invalid", detail: lastDetail });
}

function parseObject(text: string): Record<string, unknown> | null {
  try {
    const value: unknown = JSON.parse(text);
    if (typeof value !== "object" || value === null || Array.isArray(value)) return null;
    return Object.fromEntries(Object.entries(value));
  } catch {
    return null;
  }
}
