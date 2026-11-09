import { describe, expect, it } from "vitest";
import type { Node } from "web-tree-sitter";
import { expectDefined } from "../test/assertions.js";
import {
  callArgument,
  ctxCalls,
  ctxRequest,
  fromImportStatementBindings,
  importStatementBindings,
  isStringLiteral,
  literalText,
  literalUrl,
  parameterList,
} from "./python-ast.js";
import { withPythonTree } from "./python-parser.js";

/** `read` over the first node of `type` in `source`. */
function firstOf<T>(source: string, type: string, read: (node: Node) => T): Promise<T> {
  return withPythonTree(source, (root) =>
    read(expectDefined(root?.descendantsOfType(type)[0], type)),
  );
}

/** `read` over the argument of `f(<argument>)`. */
function argumentOf<T>(argument: string, read: (node: Node | null) => T): Promise<T> {
  return firstOf(`f(${argument})\n`, "call", (call) => read(callArgument(call, 0, null)));
}

describe("ctxCalls", () => {
  const calls = (source: string) =>
    withPythonTree(source, (root) =>
      ctxCalls(expectDefined(root, "root")).map((c) => `${c.namespace}.${c.method}`),
    );

  it.each([
    ["a function's parameter", "async def run(inputs, ctx):\n    ctx.files.read('a')\n"],
    ["a lambda's parameter", "f = lambda c: c.files.read('a')\n"],
    ["a reassigned parameter", "def f(ctx):\n    ctx = 1\n    ctx.files.read('a')\n"],
    [
      "an enclosing function's parameter",
      "def f(ctx):\n    def g():\n        ctx.files.read('a')\n",
    ],
    [
      "a method's second parameter",
      "class C:\n    def m(self, ctx):\n        ctx.files.read('a')\n",
    ],
    ["a keyword-only parameter", "def f(*, ctx):\n    ctx.files.read('a')\n"],
    [
      "a parameter in a comprehension's outermost iterable, which the enclosing scope evaluates",
      "def f(ctx):\n    return [ctx for ctx in ctx.files.read('a')]\n",
    ],
    [
      "a parameter a comprehension over other targets reads",
      "def f(inputs, ctx):\n    return [ctx.files.read(p) for p in inputs]\n",
    ],
    [
      "a parameter a nested function declares nonlocal",
      "def f(ctx):\n    def g():\n        nonlocal ctx\n        ctx = 1\n        ctx.files.read('a')\n",
    ],
  ])("reads %s as a receiver", async (_label, source) => {
    expect(await calls(source)).toEqual(["files.read"]);
  });

  it.each([
    ["a module-level name", "ctx.files.read('a')\n"],
    ["a method's first parameter", "class C:\n    def m(self):\n        self.files.read('a')\n"],
    [
      "a decorated method's first parameter",
      "class C:\n    @staticmethod\n    def m(ctx):\n        ctx.files.read('a')\n",
    ],
    ["a parameter used in its own default", "def f(ctx=ctx.files.read('a')):\n    pass\n"],
    ["a name a function only assigns", "def f(x):\n    client = x\n    client.files.read('a')\n"],
    ["a call two attributes deep", "def f(ctx):\n    ctx.a.files.read('a')\n"],
    ["a call one attribute deep", "def f(ctx):\n    ctx.read('a')\n"],
    [
      "a comprehension target shadowing a parameter",
      "def f(inputs, ctx):\n    return [ctx.files.read('a') for ctx in inputs]\n",
    ],
    [
      "a nested function's assignment shadowing a parameter",
      "def f(inputs, ctx):\n    def g():\n        ctx = inputs\n        ctx.files.read('a')\n",
    ],
    [
      "a nested function's for target",
      "def f(inputs, ctx):\n    def g():\n        for ctx in inputs:\n            ctx.files.read('a')\n",
    ],
    [
      "a nested function's with target",
      "def f(inputs, ctx):\n    def g():\n        with open('a') as ctx:\n            ctx.files.read('a')\n",
    ],
    [
      "a nested function's import",
      "def f(inputs, ctx):\n    def g():\n        import ctx\n        ctx.files.read('a')\n",
    ],
    [
      "a nested function's own nested definition",
      "def f(inputs, ctx):\n    def g():\n        def ctx():\n            pass\n        ctx.files.read('a')\n",
    ],
    [
      "a nested function's match capture",
      "def f(inputs, ctx):\n    def g():\n        match inputs:\n            case ctx:\n                ctx.files.read('a')\n",
    ],
    [
      "a nested function's named expression in a comprehension",
      "def f(inputs, ctx):\n    def g():\n        [(ctx := x) for x in inputs]\n        ctx.files.read('a')\n",
    ],
    [
      "a nested function's global",
      "def f(inputs, ctx):\n    def g():\n        global ctx\n        ctx.files.read('a')\n",
    ],
    [
      "a method's first parameter shadowing an enclosing parameter",
      "def f(ctx):\n    class C:\n        def m(ctx):\n            ctx.files.read('a')\n",
    ],
  ])("does not read %s as a receiver", async (_label, source) => {
    expect(await calls(source)).toEqual([]);
  });

  it("finds the URL of each ctx.http method cogmo_ctx has, and no other", async () => {
    const source =
      "def f(ctx):\n    ctx.http.get('g')\n    ctx.http.post(url='p')\n    ctx.http.request('PUT', 'r')\n    ctx.http.put('x')\n    ctx.files.read('a')\n";
    const urls = await withPythonTree(source, (root) =>
      ctxCalls(expectDefined(root, "root")).map((c) => {
        const request = ctxRequest(c);
        return request === null ? null : literalText(request.url);
      }),
    );
    expect(urls).toEqual(["g", "p", "r", null, null]);
  });
});

describe("callArgument", () => {
  const nth = (args: string, position: number, keyword: string | null) =>
    firstOf(`f(${args})\n`, "call", (call) => callArgument(call, position, keyword)?.text ?? null);

  it.each([
    ["a positional argument", "a, b", 1, "x", "b"],
    ["a keyword argument", "a, x=b", 1, "x", "b"],
    ["the position ahead of the keyword", "a, b, x=c", 1, "x", "b"],
    ["nothing past the arguments", "a", 1, "x", null],
    ["nothing after a * unpacking", "*a, b", 1, "x", null],
    ["a position before a * unpacking", "a, *b", 0, "x", "a"],
    ["a position before a ** unpacking", "a, b, **c", 1, "x", "b"],
    ["no keyword when none is asked for", "x=b", 0, null, null],
  ])("finds %s", async (_label, args, position, keyword, expected) => {
    expect(await nth(args, position, keyword)).toBe(expected);
  });
});

describe("literals", () => {
  it.each([
    ['"abc"', true, "abc"],
    ["r'a\\x41'", true, "a\\x41"],
    ['""', true, ""],
    ['"a\\x41"', true, null],
    ['f"abc"', true, "abc"],
    ['f"a{{b}}"', true, null],
    ['f"a{b}"', false, null],
    ['"a" "b"', false, null],
    ["name", false, null],
  ])("reads %s", async (source, literal, text) => {
    expect(await argumentOf(source, (node) => node !== null && isStringLiteral(node))).toBe(
      literal,
    );
    expect(await argumentOf(source, literalText)).toBe(text);
  });

  it.each([
    ['"https://h.com/a?q={x}"', { head: "https://h.com/a?q={x}", templatedPath: false }],
    ['f"https://h.com/a/{x}/b"', { head: "https://h.com/a/", templatedPath: true }],
    ['f"https://h.com/a/{x}/../b"', { head: "https://h.com/a/", templatedPath: true }],
    ['f"https://h.com/a?{q}"', { head: "https://h.com/a?", templatedPath: false }],
    ['f"https://h.com/a#{q}"', { head: "https://h.com/a#", templatedPath: false }],
    ['f"https://h.com?{q}"', { head: "https://h.com?", templatedPath: false }],
    ['f"https://h.com{p}"', null],
    ['f"https:///{x}/path"', null],
    ['f"https://@/{x}"', null],
    ['f"https://h.com:99999/{x}"', null],
    ['f"https://{h}/a"', null],
    ['f"{base}/a"', null],
    ['f"/a/{x}"', null],
    ['"https://h\\x2ecom/"', null],
    ['f"https://h.com/{x}\\n"', null],
    ["url", null],
  ])("reads the URL %s", async (source, expected) => {
    expect(await argumentOf(source, literalUrl)).toEqual(expected);
  });
});

describe("parameterList", () => {
  it("names each parameter's kind and annotation, separators excluded", async () => {
    const parameters = await firstOf(
      "def f(a: A, /, b=1, *args: T, c, d: D = 2, **kw):\n    pass\n",
      "parameters",
      (node) => parameterList(node).map((p) => [p.name, p.kind, p.annotation?.text ?? null]),
    );
    expect(parameters).toEqual([
      ["a", "positional", "A"],
      ["b", "positional", null],
      ["args", "var_positional", "T"],
      ["c", "keyword_only", null],
      ["d", "keyword_only", "D"],
      ["kw", "var_keyword", null],
    ]);
  });

  it("reads parameters after a bare `*` as keyword-only", async () => {
    const kinds = await firstOf("def f(a, *, b):\n    pass\n", "parameters", (node) =>
      parameterList(node).map((p) => p.kind),
    );
    expect(kinds).toEqual(["positional", "keyword_only"]);
  });
});

describe("import bindings", () => {
  it("binds `import a.b` to `a` and `import a.b as c` to `a.b`", async () => {
    const bindings = await firstOf("import a.b, d.e as c\n", "import_statement", (node) =>
      importStatementBindings(node).map((b) => [b.name, b.target]),
    );
    expect(bindings).toEqual([
      ["a", "a"],
      ["c", "d.e"],
    ]);
  });

  it("binds `from m import x as y` to `m.x`, and nothing for a relative import", async () => {
    const absolute = await firstOf("from m.n import x, y as z\n", "import_from_statement", (node) =>
      fromImportStatementBindings(node).map((b) => [b.name, b.target]),
    );
    expect(absolute).toEqual([
      ["x", "m.n.x"],
      ["z", "m.n.y"],
    ]);
    const relative = await firstOf("from . import x\n", "import_from_statement", (node) =>
      fromImportStatementBindings(node),
    );
    expect(relative).toEqual([]);
  });
});
