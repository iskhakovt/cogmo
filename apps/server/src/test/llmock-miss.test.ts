import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { type ChatCompletionRequest, type Fixture, LLMock } from "@copilotkit/aimock";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { type CassetteFixture, describeMiss, narrowModelMatch } from "./llmock-miss.js";

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

  it("reports a tool the request does not offer and a different endpoint", () => {
    const req = chat("ping", { tools: [{ type: "function", function: { name: "web_search" } }] });
    const cassette = [
      recorded("image.json", {
        userMessage: "ping",
        toolName: "generate_image",
        endpoint: "image",
      }),
    ];

    expect(describeMiss(req, cassette).split("\n")[2]).toBe(
      "  image.json: toolName generate_image; endpoint image",
    );
  });

  it("accepts a dated model id as its alias, as aimock's matcher does", () => {
    const req = chat("ping", { model: "claude-haiku-4-5-20251001" });
    const cassette = [recorded("haiku.json", { userMessage: "ping", model: "claude-haiku-4-5" })];

    expect(describeMiss(req, cassette).split("\n")[2]).toBe("  haiku.json: no difference found");
  });

  it("names the model when the request's id only extends the recorded one", () => {
    const req = chat("ping", { model: "claude-sonnet-5-5" });
    const cassette = [recorded("sonnet.json", { userMessage: "ping", model: "claude-sonnet-5" })];

    expect(describeMiss(req, cassette).split("\n")[2]).toBe("  sonnet.json: model claude-sonnet-5");
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

  it("says so when no fixture in the cassette is keyed on text", () => {
    const cassette = [recorded("tool.json", { toolName: "web_search" })];

    expect(describeMiss(chat("ping"), cassette).split("\n").slice(1)).toEqual([
      "closest of 1 in the cassette:",
      "  no fixture in the cassette is keyed on text",
    ]);
  });
});

describe("narrowModelMatch", () => {
  let dir: string;
  let mock: LLMock;
  let url: string;

  beforeAll(async () => {
    dir = mkdtempSync(join(tmpdir(), "cassette-"));
    const file = join(dir, "ping.json");
    writeFileSync(
      file,
      JSON.stringify({
        fixtures: [
          {
            match: { userMessage: "ping", model: "claude-sonnet-5" },
            response: { content: "pong" },
          },
        ],
      }),
    );
    mock = new LLMock({ port: 0, logLevel: "silent", strict: true });
    mock.loadFixtureFile(file);
    mock.getFixtures().forEach(narrowModelMatch);
    url = await mock.start();
  });

  afterAll(async () => {
    await mock.stop();
    rmSync(dir, { recursive: true, force: true });
  });

  async function answered(model: string): Promise<boolean> {
    const res = await fetch(`${url}/v1/messages`, {
      method: "POST",
      headers: { "content-type": "application/json", "anthropic-version": "2023-06-01" },
      body: JSON.stringify({
        model,
        max_tokens: 16,
        messages: [{ role: "user", content: "ping" }],
      }),
    });
    return res.ok;
  }

  it.each([
    ["the recorded model", "claude-sonnet-5", true],
    ["its dated snapshot", "claude-sonnet-5-20260101", true],
    ["a later model whose id extends it", "claude-sonnet-5-5", false],
  ])("answers %s (%s): %s", async (_label, model, ok) => {
    expect(await answered(model)).toBe(ok);
  });
});
