import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { z } from "zod";
import { repoRoot } from "../test/repo-root.js";
import {
  GENERATED_CONTRACT_FILES,
  renderContractSchema,
  renderPythonContract,
  renderPythonModule,
  renderRuntimePackages,
} from "./ctx-contract-codegen.js";

describe("the generated ctx contract", () => {
  it.each([
    [GENERATED_CONTRACT_FILES.schema, renderContractSchema],
    [GENERATED_CONTRACT_FILES.python, renderPythonContract],
    [GENERATED_CONTRACT_FILES.runtimePackages, renderRuntimePackages],
  ])(
    "%s matches the contract; run `pnpm --filter cogmo codegen:ctx` when it does not",
    (path, render) => {
      expect(readFileSync(join(repoRoot(), path), "utf8")).toBe(render());
    },
  );

  it("names the frames, the refusal kinds and a ctx method's arguments and result", () => {
    const document: unknown = JSON.parse(renderContractSchema());
    expect(document).toMatchObject({
      $defs: Object.fromEntries(
        [
          "task_invoke",
          "task_result",
          "ctx_call",
          "ctx_result",
          "task_exited",
          "supervisor_ready",
          "CtxErrorKind",
          "ctx.http.request.args",
          "ctx.http.request.result",
          "ctx.now.args",
        ].map((name) => [name, expect.any(Object)]),
      ),
    });
  });
});

describe("renderPythonModule", () => {
  function moduleFor(result: z.ZodType): string {
    return renderPythonModule({ results: { probe: result }, errorKinds: ["internal"] });
  }

  it("types each shape the contract can hold", () => {
    const rendered = moduleFor(
      z
        .object({
          text: z.string(),
          count: z.number().int(),
          ratio: z.number(),
          on: z.boolean(),
          tags: z.array(z.string()),
          headers: z.record(z.string(), z.string()),
          mode: z.enum(["a", "b"]),
          kind: z.literal("fixed"),
          either: z.union([z.string(), z.null()]),
          // A constraint keeps Zod from folding the union into one `type` array.
          anyOf: z.union([z.string().min(1), z.null()]),
          oneOf: z.discriminatedUnion("tag", [
            z.object({ tag: z.literal("a") }).meta({ title: "TagA" }),
            z.object({ tag: z.literal("b") }).meta({ title: "TagB" }),
          ]),
          flag: z.literal(true),
          extra: z.unknown(),
          maybe: z.string().optional(),
          nested: z.object({ n: z.number().int() }).meta({ title: "Nested" }),
        })
        .meta({ title: "Probe" }),
    );
    expect(rendered).toContain(
      [
        "class Probe(TypedDict):",
        "    text: str",
        "    count: int",
        "    ratio: float",
        "    on: bool",
        "    tags: list[str]",
        "    headers: dict[str, str]",
        '    mode: Literal["a", "b"]',
        '    kind: Literal["fixed"]',
        "    either: str | None",
        "    anyOf: str | None",
        "    oneOf: TagA | TagB",
        "    flag: Literal[True]",
        "    extra: object",
        "    maybe: NotRequired[str]",
        "    nested: Nested",
      ].join("\n"),
    );
    expect(rendered.indexOf("class Nested(TypedDict):")).toBeLessThan(
      rendered.indexOf("class Probe("),
    );
    expect(rendered).toContain(
      "from typing import Any, Literal, NotRequired, Protocol, TypedDict, overload",
    );
    expect(rendered).toContain(
      '    async def call(self, method: Literal["probe"], args: Mapping[str, object]) -> Probe: ...',
    );
  });

  it("writes an object with no fields as a class with an empty body", () => {
    expect(moduleFor(z.object({}).meta({ title: "Empty" }))).toContain(
      "class Empty(TypedDict):\n    pass",
    );
  });

  it("refuses an object with no title, a shape it cannot type, and two objects sharing a title", () => {
    expect(() => moduleFor(z.object({ a: z.string() }))).toThrow(/has no title/);
    expect(() => moduleFor(z.tuple([z.string(), z.number()]))).toThrow(
      /a shape Python cannot type/,
    );
    expect(() =>
      moduleFor(
        z
          .object({
            first: z.object({ a: z.string() }).meta({ title: "Same" }),
            second: z.object({ b: z.string() }).meta({ title: "Same" }),
          })
          .meta({ title: "Outer" }),
      ),
    ).toThrow(/share the title Same/);
  });
});
