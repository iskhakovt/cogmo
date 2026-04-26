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

  it("handles CRLF line endings", async () => {
    const s = streamOf('{"a":1}\r\n{"b":2}\r\n');
    expect(await collect(s)).toEqual([{ a: 1 }, { b: 2 }]);
  });

  it("handles an empty stream", async () => {
    expect(await collect(streamOf())).toEqual([]);
  });
});
