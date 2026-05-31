import { describe, expect, it } from "vitest";
import type { Message } from "../llm/types.js";
import { extractGeneratedDocuments, extractGeneratedImages } from "./extract-images.js";

describe("extractGeneratedImages", () => {
  it("returns empty array for empty messages", () => {
    expect(extractGeneratedImages([])).toEqual([]);
  });

  it("returns empty array for string-content messages", () => {
    const messages: Message[] = [
      { role: "user", content: "hello" },
      { role: "assistant", content: "hi" },
    ];
    expect(extractGeneratedImages(messages)).toEqual([]);
  });

  it("extracts generate_image tool results", () => {
    const messages: Message[] = [
      {
        role: "assistant",
        content: [
          {
            type: "tool_use",
            id: "toolu_1",
            name: "generate_image",
            input: { prompt: "a cat" },
          },
        ],
      },
      {
        role: "user",
        content: [
          {
            type: "tool_result",
            toolUseId: "toolu_1",
            content: JSON.stringify({
              path: "generated/abc.jpg",
              mediaType: "image/jpeg",
              model: "fal-ai/flux/dev",
            }),
          },
        ],
      },
    ];
    expect(extractGeneratedImages(messages)).toEqual([
      { path: "generated/abc.jpg", mediaType: "image/jpeg" },
    ]);
  });

  it("ignores tool_results from other tools with same JSON shape", () => {
    // Another tool returns {path, mediaType} — should not be extracted.
    const messages: Message[] = [
      {
        role: "assistant",
        content: [
          {
            type: "tool_use",
            id: "toolu_1",
            name: "some_other_tool",
            input: {},
          },
        ],
      },
      {
        role: "user",
        content: [
          {
            type: "tool_result",
            toolUseId: "toolu_1",
            content: JSON.stringify({ path: "other/x.jpg", mediaType: "image/jpeg" }),
          },
        ],
      },
    ];
    expect(extractGeneratedImages(messages)).toEqual([]);
  });

  it("skips tool_results with non-JSON content", () => {
    const messages: Message[] = [
      {
        role: "assistant",
        content: [{ type: "tool_use", id: "toolu_1", name: "generate_image", input: {} }],
      },
      {
        role: "user",
        content: [
          {
            type: "tool_result",
            toolUseId: "toolu_1",
            content: "Error: something broke",
          },
        ],
      },
    ];
    expect(extractGeneratedImages(messages)).toEqual([]);
  });

  it("skips tool_results with isError=true", () => {
    const messages: Message[] = [
      {
        role: "assistant",
        content: [{ type: "tool_use", id: "toolu_1", name: "generate_image", input: {} }],
      },
      {
        role: "user",
        content: [
          {
            type: "tool_result",
            toolUseId: "toolu_1",
            content: JSON.stringify({ path: "generated/x.jpg", mediaType: "image/jpeg" }),
            isError: true,
          },
        ],
      },
    ];
    expect(extractGeneratedImages(messages)).toEqual([]);
  });

  it("skips JSON missing required fields", () => {
    const messages: Message[] = [
      {
        role: "assistant",
        content: [{ type: "tool_use", id: "toolu_1", name: "generate_image", input: {} }],
      },
      {
        role: "user",
        content: [
          {
            type: "tool_result",
            toolUseId: "toolu_1",
            content: JSON.stringify({ model: "fal-ai/flux/dev" }),
          },
        ],
      },
    ];
    expect(extractGeneratedImages(messages)).toEqual([]);
  });

  it("extracts multiple images from separate turns", () => {
    const messages: Message[] = [
      {
        role: "assistant",
        content: [{ type: "tool_use", id: "toolu_1", name: "generate_image", input: {} }],
      },
      {
        role: "user",
        content: [
          {
            type: "tool_result",
            toolUseId: "toolu_1",
            content: JSON.stringify({ path: "generated/a.jpg", mediaType: "image/jpeg" }),
          },
        ],
      },
      {
        role: "assistant",
        content: [{ type: "tool_use", id: "toolu_2", name: "generate_image", input: {} }],
      },
      {
        role: "user",
        content: [
          {
            type: "tool_result",
            toolUseId: "toolu_2",
            content: JSON.stringify({ path: "generated/b.png", mediaType: "image/png" }),
          },
        ],
      },
    ];
    expect(extractGeneratedImages(messages)).toEqual([
      { path: "generated/a.jpg", mediaType: "image/jpeg" },
      { path: "generated/b.png", mediaType: "image/png" },
    ]);
  });

  it("handles mixed tool_uses across messages (builds name map globally)", () => {
    // The tool_use and matching tool_result may be in the same message's content,
    // but in practice they're in separate messages. The two-pass extraction
    // should resolve them regardless of interleaving.
    const messages: Message[] = [
      {
        role: "assistant",
        content: [
          { type: "tool_use", id: "toolu_web", name: "web_search", input: {} },
          { type: "tool_use", id: "toolu_img", name: "generate_image", input: {} },
        ],
      },
      {
        role: "user",
        content: [
          {
            type: "tool_result",
            toolUseId: "toolu_web",
            content: "web search results",
          },
          {
            type: "tool_result",
            toolUseId: "toolu_img",
            content: JSON.stringify({ path: "generated/z.jpg", mediaType: "image/jpeg" }),
          },
        ],
      },
    ];
    expect(extractGeneratedImages(messages)).toEqual([
      { path: "generated/z.jpg", mediaType: "image/jpeg" },
    ]);
  });
});

describe("extractGeneratedDocuments", () => {
  it("returns empty array for empty messages", () => {
    expect(extractGeneratedDocuments([])).toEqual([]);
  });

  it("extracts send_document tool results", () => {
    const messages: Message[] = [
      {
        role: "assistant",
        content: [
          {
            type: "tool_use",
            id: "toolu_1",
            name: "send_document",
            input: { filename: "report.md", content: "x" },
          },
        ],
      },
      {
        role: "user",
        content: [
          {
            type: "tool_result",
            toolUseId: "toolu_1",
            content: JSON.stringify({
              path: "generated/abc.md",
              mediaType: "text/markdown",
              name: "report.md",
            }),
          },
        ],
      },
    ];
    expect(extractGeneratedDocuments(messages)).toEqual([
      { path: "generated/abc.md", mediaType: "text/markdown", name: "report.md" },
    ]);
  });

  it("ignores tool_results from other tools with same JSON shape", () => {
    const messages: Message[] = [
      {
        role: "assistant",
        content: [{ type: "tool_use", id: "toolu_1", name: "some_other_tool", input: {} }],
      },
      {
        role: "user",
        content: [
          {
            type: "tool_result",
            toolUseId: "toolu_1",
            content: JSON.stringify({
              path: "other/x.md",
              mediaType: "text/markdown",
              name: "x.md",
            }),
          },
        ],
      },
    ];
    expect(extractGeneratedDocuments(messages)).toEqual([]);
  });

  it("skips tool_results with isError=true", () => {
    const messages: Message[] = [
      {
        role: "assistant",
        content: [{ type: "tool_use", id: "toolu_1", name: "send_document", input: {} }],
      },
      {
        role: "user",
        content: [
          {
            type: "tool_result",
            toolUseId: "toolu_1",
            content: JSON.stringify({
              path: "generated/x.md",
              mediaType: "text/markdown",
              name: "x.md",
            }),
            isError: true,
          },
        ],
      },
    ];
    expect(extractGeneratedDocuments(messages)).toEqual([]);
  });

  it("skips tool_results with malformed payload", () => {
    const messages: Message[] = [
      {
        role: "assistant",
        content: [{ type: "tool_use", id: "toolu_1", name: "send_document", input: {} }],
      },
      {
        role: "user",
        content: [
          {
            type: "tool_result",
            toolUseId: "toolu_1",
            content: "not json",
          },
        ],
      },
    ];
    expect(extractGeneratedDocuments(messages)).toEqual([]);
  });

  it("skips JSON missing required fields", () => {
    const messages: Message[] = [
      {
        role: "assistant",
        content: [{ type: "tool_use", id: "toolu_1", name: "send_document", input: {} }],
      },
      {
        role: "user",
        content: [
          {
            type: "tool_result",
            toolUseId: "toolu_1",
            // Missing `name`
            content: JSON.stringify({ path: "x", mediaType: "text/markdown" }),
          },
        ],
      },
    ];
    expect(extractGeneratedDocuments(messages)).toEqual([]);
  });

  it("extracts multiple documents from separate turns", () => {
    const messages: Message[] = [
      {
        role: "assistant",
        content: [{ type: "tool_use", id: "toolu_1", name: "send_document", input: {} }],
      },
      {
        role: "user",
        content: [
          {
            type: "tool_result",
            toolUseId: "toolu_1",
            content: JSON.stringify({ path: "g/a.md", mediaType: "text/markdown", name: "a.md" }),
          },
        ],
      },
      {
        role: "assistant",
        content: [{ type: "tool_use", id: "toolu_2", name: "send_document", input: {} }],
      },
      {
        role: "user",
        content: [
          {
            type: "tool_result",
            toolUseId: "toolu_2",
            content: JSON.stringify({ path: "g/b.csv", mediaType: "text/csv", name: "b.csv" }),
          },
        ],
      },
    ];
    expect(extractGeneratedDocuments(messages)).toEqual([
      { path: "g/a.md", mediaType: "text/markdown", name: "a.md" },
      { path: "g/b.csv", mediaType: "text/csv", name: "b.csv" },
    ]);
  });
});
