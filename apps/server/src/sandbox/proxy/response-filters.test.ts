import { Readable } from "node:stream";
import { text } from "node:stream/consumers";
import { describe, expect, it } from "vitest";
import { expectOk } from "../../test/assertions.js";
import { createdExecId, filterContainerList, taskEventFilter } from "./response-filters.js";

const TASK = "019d0000-0000-7000-8000-00000000aaaa";
/** The task's own container. */
const TASK_CONTAINER = "1a".padEnd(64, "0");
const SIBLING_CONTAINER = "3c".padEnd(64, "0");

function event(id: string, attributes: Record<string, string> | null): string {
  return JSON.stringify({
    Type: "container",
    Action: "start",
    Actor: { ID: id, Attributes: attributes },
  });
}

async function filtered(chunks: ReadonlyArray<Buffer | string>): Promise<string> {
  return text(
    Readable.from(chunks.map((c) => Buffer.from(c))).pipe(taskEventFilter(TASK_CONTAINER)),
  );
}

describe("filterContainerList", () => {
  it("keeps only the owned ids, in the daemon's order", () => {
    const raw = Buffer.from(JSON.stringify([{ Id: "a", Names: ["/a"] }, { Id: "b" }, { Id: "c" }]));

    const kept = filterContainerList(raw, new Set(["c", "a"]));

    expect(JSON.parse(expectOk(kept).toString("utf8"))).toEqual([
      { Id: "a", Names: ["/a"] },
      { Id: "c" },
    ]);
  });

  it.each([
    ["not JSON", "[{"],
    ["not a list", '{"Id":"a"}'],
    ["an entry without an Id", '[{"Names":["/a"]}]'],
  ])("is unavailable for a reply that is %s", (_label, raw) => {
    const kept = filterContainerList(Buffer.from(raw), new Set(["a"]));

    expect(kept._unsafeUnwrapErr().kind).toBe("unavailable");
  });
});

describe("createdExecId", () => {
  it("reads the Id of an exec create's 201", () => {
    const id = "e".repeat(64);
    expect(createdExecId(Buffer.from(JSON.stringify({ Id: id })))).toBe(id);
  });

  it.each([
    ["not JSON", "{"],
    ["an Id that is not a full hex id", '{"Id":"../../containers/x"}'],
    ["no Id", "{}"],
  ])("is null for a body that is %s", (_label, raw) => {
    expect(createdExecId(Buffer.from(raw))).toBeNull();
  });
});

describe("taskEventFilter", () => {
  it("keeps the task container's lines and its children's, and drops every other", async () => {
    const own = event(TASK_CONTAINER, { "cogmo.root_task": TASK, "cogmo.parent": "" });
    const child = event("2b".padEnd(64, "0"), { "cogmo.parent": TASK_CONTAINER });
    const out = await filtered([
      [
        own,
        event("7a".padEnd(64, "0"), { "cogmo.root_task": TASK, "cogmo.parent": "" }),
        child,
        event(SIBLING_CONTAINER, null),
        event("8b".padEnd(64, "0"), { "cogmo.parent": SIBLING_CONTAINER }),
        JSON.stringify({
          Type: "network",
          Actor: { ID: "n", Attributes: { container: TASK_CONTAINER } },
        }),
        JSON.stringify({ Type: "volume", Actor: { ID: "v", Attributes: { driver: "local" } } }),
        JSON.stringify({ Type: "container", Actor: { Attributes: { "cogmo.parent": "" } } }),
        "not json",
        "",
      ].join("\n"),
    ]);

    expect(out).toBe(`${own}\n${child}\n`);
  });

  it("reassembles a line split across chunks, a multi-byte character included", async () => {
    const own = event(TASK_CONTAINER, { name: "ünïcode" });
    const bytes = Buffer.from(`${own}\n`);
    const cut = bytes.indexOf(Buffer.from("ü")) + 1;

    const out = await filtered([bytes.subarray(0, cut), bytes.subarray(cut)]);

    expect(out).toBe(`${own}\n`);
  });

  it("keeps a last line the stream ends without a newline", async () => {
    const own = event(TASK_CONTAINER, null);

    expect(await filtered([own])).toBe(own);
  });

  it("drops a line past the bound up to its newline and keeps the next", async () => {
    const own = event(TASK_CONTAINER, null);
    const huge = `{"Actor":{"ID":"${TASK_CONTAINER}","Attributes":{"x":"${"y".repeat(5 * 1024 * 1024)}"}}}`;
    const half = Math.floor(huge.length / 2);

    const out = await filtered([huge.slice(0, half), huge.slice(half), `\n${own}\n`]);

    expect(out).toBe(`${own}\n`);
  });
});
