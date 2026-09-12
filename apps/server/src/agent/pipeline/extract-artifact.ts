/**
 * Convert an agentic stage's final reply into the typed artifact its
 * envelope declares. `text` is the reply itself. `json` is one tools-free
 * call that restates the result as JSON matching the compiler-emitted JSON
 * Schema, checked with ajv and retried once with the validation errors fed
 * back — the same repair shape as `chatTyped`, which can't be used directly
 * because the schema here is user-shaped JSON Schema, not a Zod type.
 *
 * The schema travels in the prompt, not as provider structured output:
 * providers that enforce strict mode reject ordinary schemas (optional
 * properties, open objects), and a user's definition is under no obligation
 * to be strict-compatible. ajv is the authority on the result either way.
 *
 * The agent loop itself can't produce the JSON: a stage that uses tools
 * needs them until its last iteration.
 */

import { Ajv } from "ajv";
import { err, ok, type Result } from "neverthrow";
import type { LlmProvider } from "../../llm/provider.js";
import type { Message } from "../../llm/types.js";
import type { StageArtifact } from "./run-types.js";
import type { StageOutput } from "./types.js";

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

  // The artifact is stored as an object map, so the schema must describe one.
  if (output.schema.type !== "object") {
    return err({
      kind: "artifact_invalid",
      detail: `output schema must have top-level "type": "object", got ${JSON.stringify(output.schema.type)}`,
    });
  }
  // One Ajv per extraction: a shared instance caches every compiled schema by
  // object identity and refuses a second schema registering the same `$id`.
  const validate = new Ajv({ allErrors: true, strict: false }).compile(output.schema);
  const messages: Message[] = [
    {
      role: "user",
      content:
        "Convert this pipeline stage result into a JSON object matching the JSON Schema below. " +
        "Use only information present in the result. Reply with the JSON object only.\n\n" +
        `<schema>\n${JSON.stringify(output.schema)}\n</schema>\n\n<result>\n${finalText}\n</result>`,
    },
  ];

  let lastDetail = "";
  for (let attempt = 0; attempt <= JSON_ARTIFACT_RETRIES; attempt++) {
    const response = await args.provider.chat({
      model: args.model,
      system: "You extract structured data from text. Reply with a single JSON object only.",
      messages,
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
        content: `That does not match the schema: ${lastDetail}. Reply with a corrected JSON object only.`,
      },
    );
  }
  return err({ kind: "artifact_invalid", detail: lastDetail });
}

/** Parse a reply that may wrap its JSON object in a Markdown code fence. */
function parseObject(text: string): Record<string, unknown> | null {
  const fenced = /^\s*```(?:json)?\s*\n([\s\S]*?)\n?```\s*$/.exec(text);
  try {
    const value: unknown = JSON.parse(fenced?.[1] ?? text);
    if (typeof value !== "object" || value === null || Array.isArray(value)) return null;
    return Object.fromEntries(Object.entries(value));
  } catch {
    return null;
  }
}
