import type { ChatCompletionRequest, Fixture } from "@copilotkit/aimock";
import { describe, expect, it } from "vitest";
import { type CassetteFixture, describeMiss } from "./llmock-miss.js";

function chat(text: string, extra: Partial<ChatCompletionRequest> = {}): ChatCompletionRequest {
  return { model: "claude-sonnet-5", messages: [{ role: "user", content: text }], ...extra };
}

function recorded(file: string, match: Fixture["match"]): CassetteFixture {
  return { file, fixture: { match, response: { content: "ok" } } };
}

describe("describeMiss", () => {
  it("names the request's key", () => {
    const req = chat("what is the weather in Lisbon", {
      tools: [{ type: "function", function: { name: "web_search" } }],
    });

    const [key] = describeMiss(req, []).split("\n");

    expect(key).toBe(
      'no fixture matched endpoint=chat model=claude-sonnet-5 turn=0 hasToolResult=false tools=web_search text=(29 chars) "what is the weather in Lisbon"',
    );
  });

  it("ranks candidates by how much text they share and says where each diverges", () => {
    const req = chat("remember that my homelab IP is 10.0.10.1");
    const cassette = [
      recorded("unrelated.json", { userMessage: "draw me a cat", model: "claude-sonnet-5" }),
      recorded("near.json", {
        userMessage: "remember that my homelab IP is 10.0.10.10",
        model: "claude-sonnet-5",
      }),
      recorded("far.json", { userMessage: "remember my birthday", model: "claude-sonnet-5" }),
    ];

    const lines = describeMiss(req, cassette).split("\n");

    expect(lines[1]).toBe("closest of 3 in the cassette:");
    expect(lines[2]).toMatch(/^ {2}near\.json: text differs at char 40: /);
    expect(lines[3]).toMatch(/^ {2}far\.json: text differs at char 9: /);
    expect(lines[4]).toMatch(/^ {2}unrelated\.json: /);
  });

  it("reports the fields that differ when the text is the same", () => {
    const req = chat("ping", {
      messages: [
        { role: "user", content: "ping" },
        { role: "assistant", content: null },
        { role: "tool", content: "pong", tool_call_id: "t1" },
      ],
    });
    const cassette = [
      recorded("haiku.json", {
        userMessage: "ping",
        model: "claude-haiku-4-5",
        hasToolResult: false,
      }),
    ];

    expect(describeMiss(req, cassette).split("\n")[2]).toBe(
      "  haiku.json: model claude-haiku-4-5; hasToolResult false",
    );
  });

  it("accepts a dated model id as its alias, as aimock's matcher does", () => {
    const req = chat("ping", { model: "claude-haiku-4-5-20251001" });
    const cassette = [recorded("haiku.json", { userMessage: "ping", model: "claude-haiku-4-5" })];

    expect(describeMiss(req, cassette).split("\n")[2]).toBe("  haiku.json: no difference found");
  });

  it("keys an embedding request on its input", () => {
    const req = chat("", {
      model: "text-embedding-3-small",
      messages: [],
      embeddingInput: "User prefers dark mode.",
      _endpointType: "embedding",
    });
    const cassette = [
      recorded("dark.json", { inputText: "User prefers dark mode", endpoint: "embedding" }),
    ];

    const lines = describeMiss(req, cassette).split("\n");

    expect(lines[0]).toContain("endpoint=embedding model=text-embedding-3-small");
    expect(lines[2]).toMatch(/^ {2}dark\.json: text differs at char 22: /);
  });

  it("says so when the cassette is empty", () => {
    expect(describeMiss(chat("ping"), []).split("\n").slice(1)).toEqual([
      "closest of 0 in the cassette:",
      "  the cassette is empty",
    ]);
  });
});
