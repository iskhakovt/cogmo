import { Readable } from "node:stream";
import { describe, expect, it } from "vitest";
import { readJsonl } from "./jsonl.js";

function streamOf(...chunks: string[]): Readable {
  let i = 0;
  return new Readable({
    read() {
      if (i < chunks.length) {
        this.push(chunks[i++]);
      } else {
        this.push(null);
      }
    },
  });
}

async function collect(stream: Readable): Promise<unknown[]> {
  const out: unknown[] = [];
  for await (const r of readJsonl(stream)) out.push(r);
  return out;
}

describe("readJsonl", () => {
  it("parses one record per line", async () => {
    const s = streamOf('{"a":1}\n{"a":2}\n{"a":3}\n');
    expect(await collect(s)).toEqual([{ a: 1 }, { a: 2 }, { a: 3 }]);
  });

  it("handles records split across chunks", async () => {
    const s = streamOf('{"a":', "1}\n{", '"b":2}\n');
    expect(await collect(s)).toEqual([{ a: 1 }, { b: 2 }]);
  });

  it("flushes a trailing line without a final newline", async () => {
    const s = streamOf('{"a":1}\n{"a":2}');
    expect(await collect(s)).toEqual([{ a: 1 }, { a: 2 }]);
  });

  it("skips blank lines", async () => {
    const s = streamOf('\n{"a":1}\n\n\n{"b":2}\n');
    expect(await collect(s)).toEqual([{ a: 1 }, { b: 2 }]);
  });

  it("skips malformed lines and continues", async () => {
    const s = streamOf('{"a":1}\nnot json\n{"b":2}\n');
    expect(await collect(s)).toEqual([{ a: 1 }, { b: 2 }]);
  });

  it("silently drops PTY shell preamble (echoed exec, OSC title, mode-reset)", async () => {
    // Real-world preamble captured from a Daytona PTY shell — bash echoes
    // the typed `exec …` line in cooked mode and emits OSC title sequences
    // via PROMPT_COMMAND even with PS1 empty. Lines without a `{` are
    // non-records and must drop without raising the warn-log floor.
    const s = streamOf(
      "exec 'claude' '-p' '--output-format' 'stream-json' < '/tmp/...'\n",
      "\x1b]2;exec 'claude'…\x07\x1b[?2004l\n",
      '{"type":"system","subtype":"init"}\n',
      "\x1b]0;\x07\n",
      '{"type":"assistant","content":"hi"}\n',
    );
    expect(await collect(s)).toEqual([
      { type: "system", subtype: "init" },
      { type: "assistant", content: "hi" },
    ]);
  });

  it("extracts JSON from a line with leading OSC/ANSI prefix", async () => {
    // Real-world capture: bash emits a final OSC icon-name sequence as
    // it transitions out of interactive mode, and claude's first
    // stream-json event arrives on the SAME PTY line (no newline
    // between bash's `\e]1;exec\a` and claude's `{...}` write). A strict
    // first-char-must-be-`{` filter drops this line and the orchestrator
    // never sees the `system init` event → no session_id captured →
    // execute orchestrator fails with "no session_id".
    const s = streamOf('\x1b]1;exec\x07{"type":"system","subtype":"init","session_id":"abc"}\n');
    expect(await collect(s)).toEqual([{ type: "system", subtype: "init", session_id: "abc" }]);
  });

  it("handles CRLF line endings", async () => {
    const s = streamOf('{"a":1}\r\n{"b":2}\r\n');
    expect(await collect(s)).toEqual([{ a: 1 }, { b: 2 }]);
  });

  it("handles an empty stream", async () => {
    expect(await collect(streamOf())).toEqual([]);
  });
});
