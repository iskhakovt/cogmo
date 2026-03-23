import { createServer } from "node:http";

const PORT = process.env.PORT ?? 3000;

/** Canned response for POST /v1/messages */
function messagesResponse(body) {
  const model = body.model ?? "claude-sonnet-4-20250514";
  return {
    id: `msg_mock_${Date.now()}`,
    type: "message",
    role: "assistant",
    model,
    content: [
      {
        type: "text",
        text: `Mock response to: ${extractText(body.messages)}`,
      },
    ],
    stop_reason: "end_turn",
    stop_sequence: null,
    usage: {
      input_tokens: 25,
      output_tokens: 10,
      cache_creation_input_tokens: null,
      cache_read_input_tokens: null,
    },
  };
}

function extractText(messages) {
  const last = messages?.[messages.length - 1];
  if (!last) return "(empty)";
  if (typeof last.content === "string") return last.content;
  if (Array.isArray(last.content)) {
    const textBlock = last.content.find((b) => b.type === "text");
    if (textBlock) return textBlock.text;
    const toolResult = last.content.find((b) => b.type === "tool_result");
    if (toolResult) return `[tool_result: ${toolResult.content}]`;
  }
  return "(unknown)";
}

const server = createServer((req, res) => {
  if (req.method === "POST" && req.url === "/v1/messages") {
    let body = "";
    req.on("data", (chunk) => {
      body += chunk;
    });
    req.on("end", () => {
      try {
        const parsed = JSON.parse(body);
        const response = messagesResponse(parsed);
        res.writeHead(200, { "Content-Type": "application/json" });
        res.end(JSON.stringify(response));
      } catch (err) {
        res.writeHead(400, { "Content-Type": "application/json" });
        res.end(JSON.stringify({ error: { type: "invalid_request", message: err.message } }));
      }
    });
    return;
  }

  if (req.url === "/health") {
    res.writeHead(200);
    res.end("ok");
    return;
  }

  res.writeHead(404);
  res.end("not found");
});

server.listen(PORT, () => {
  console.log(`Mock Anthropic server listening on :${PORT}`);
});
