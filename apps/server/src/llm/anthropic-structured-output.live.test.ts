/**
 * Live: `responseFormat` through `AnthropicProvider` on the real endpoint.
 *
 * Replay can't show this: the API decides which request shapes a model
 * accepts. Each case sends one small extraction and parses the reply against
 * the schema. The closed schema takes structured outputs; the one with a
 * `z.record` field takes the tool path.
 *
 * Skipped unless `LIVE=1` and `ANTHROPIC_API_KEY` are set. Costs under a cent.
 *
 *   set -a; . ./.env; set +a; LIVE=1 pnpm test:live
 */

import { describe, expect, it } from "vitest";
import { z } from "zod";
import { expectDefined } from "../test/assertions.js";
import { AnthropicProvider } from "./anthropic.js";
import { extractText } from "./content.js";
import { toObjectJsonSchema } from "./json-schema.js";
import type { ChatParams, Usage } from "./types.js";

// An empty `ANTHROPIC_API_KEY=` line in `.env` counts as unset.
const API_KEY = (process.env.LIVE === "1" && process.env.ANTHROPIC_API_KEY) || undefined;

const PersonSchema = z.object({
  name: z.string().min(1),
  city: z.string().min(1),
  role: z.enum(["engineer", "designer", "manager"]),
});

const TaggedPersonSchema = z.object({
  name: z.string().min(1),
  attributes: z.record(z.string(), z.string()),
});

const MESSAGES: ChatParams["messages"] = [
  { role: "user", content: "Maria Santos works as a designer and lives in Lisbon." },
];

const usages: Array<{ model: string; schema: string } & Usage> = [];

async function extract<T>(model: string, name: string, schema: z.ZodType<T>): Promise<T> {
  const provider = new AnthropicProvider(expectDefined(API_KEY, "API key"));
  const response = await provider.chat({
    model,
    system: "Extract the person the user describes.",
    messages: MESSAGES,
    responseFormat: { type: "json_schema", name, schema: toObjectJsonSchema(schema) },
    maxTokens: 4000,
  });
  usages.push({ model, schema: name, ...response.usage });
  expect(response.stopReason).toBe("end_turn");
  return schema.parse(JSON.parse(extractText(response.content)));
}

describe.skipIf(API_KEY === undefined)("AnthropicProvider structured output (live)", () => {
  it.each(["claude-opus-5-5", "claude-sonnet-5"])(
    "%s returns a closed schema's JSON through structured outputs",
    async (model) => {
      const person = await extract(model, "person", PersonSchema);
      expect(person).toEqual({ name: "Maria Santos", city: "Lisbon", role: "designer" });
    },
  );

  it("claude-opus-5-5 answers an open-object schema through the unforced tool", async () => {
    const person = await extract("claude-opus-5-5", "tagged_person", TaggedPersonSchema);
    expect(person.name).toBe("Maria Santos");
    expect(Object.values(person.attributes).map((v) => v.toLowerCase())).toEqual(
      expect.arrayContaining(["designer", "lisbon"]),
    );
    console.table(usages);
  });
});
