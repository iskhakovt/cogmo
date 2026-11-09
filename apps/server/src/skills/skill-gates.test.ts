import * as R from "remeda";
import { afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import type { Node } from "web-tree-sitter";
import type { SkillTree } from "./python-ast.js";
import { loadPythonParser } from "./python-parser.js";
import { formatSkillFinding, runSkillGates, type SkillFinding } from "./skill-gates.js";
import type { SkillManifest } from "./types.js";

/** Whether `withPythonTree` hands its reader a null tree, as tree-sitter may. */
const parser = vi.hoisted(() => ({ nullTree: false }));

vi.mock("./python-parser.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("./python-parser.js")>();
  return {
    ...actual,
    withPythonTree: <T>(source: string, read: (root: Node | null) => T): Promise<T> =>
      parser.nullTree ? Promise.resolve(read(null)) : actual.withPythonTree(source, read),
  };
});

afterEach(() => {
  parser.nullTree = false;
});

function manifestWith(overrides: Partial<SkillManifest> = {}): SkillManifest {
  return {
    name: "echo",
    description: "skill-gates fixture skill",
    tier: "wasm",
    triggers: ["manual"],
    inputs: { type: "object", properties: {} },
    effects: [],
    secrets: [],
    dependencies: [],
    cost_per_call_usd: 0,
    ...overrides,
  } satisfies SkillManifest;
}

const RUN = "async def run(inputs, ctx):\n    return {}\n";

/** The fixture skill on the wasm tier, with no effects, network or secrets. */
const WASM = manifestWith();

/** The gates' findings, none when they pass. */
async function gate(body: string, manifest: SkillManifest): Promise<readonly SkillFinding[]> {
  const gated = await runSkillGates({ name: "echo", manifest, body }, () => undefined);
  return gated.match(
    () => [],
    (findings) => findings,
  );
}

/** Each finding as `<id> <line>:<column> <message>`, for compact assertions. */
async function findingsUnder(manifest: SkillManifest, body: string): Promise<string[]> {
  return (await gate(body, manifest)).map(
    (f) => `${f.id} ${f.line ?? "-"}:${f.column ?? "-"} ${f.message}`,
  );
}

/** {@link findingsUnder} the wasm-tier fixture. */
function findings(body: string): Promise<string[]> {
  return findingsUnder(WASM, body);
}

describe("formatSkillFinding", () => {
  it.each([
    [{ line: 3, column: 7 }, "entrypoint: skills/echo/skill.py:3:7: msg"],
    [{ line: 3, column: null }, "entrypoint: skills/echo/skill.py:3: msg"],
    [{ line: null, column: null }, "entrypoint: skills/echo/skill.py: msg"],
  ])("writes the position %o as far as it goes", (position, expected) => {
    expect(
      formatSkillFinding({
        id: "entrypoint",
        path: "skills/echo/skill.py",
        message: "msg",
        ...position,
      }),
    ).toBe(expected);
  });
});

describe("size", () => {
  const pad = (n: number) => "# pad\n".repeat(n);

  it.each([
    ["400 lines", `${RUN}${pad(398)}`, []],
    ["401 lines", `${RUN}${pad(399)}`, ["size -:- 401 lines, over the limit of 400"]],
    [
      "400 lines ending in \\r\\n, each counted once",
      `${RUN}${pad(398)}`.replaceAll("\n", "\r\n"),
      [],
    ],
    [
      "400 lines and a last one with no newline",
      `${RUN}${pad(398)}x = 1`,
      ["size -:- 401 lines, over the limit of 400"],
    ],
    // A lone \r ends no line: these 401 comments are one line, which then parses.
    ["a lone \\r between comments", `${RUN}${"# c\r".repeat(401)}\n`, []],
  ])("counts %s", async (_label, body, expected) => {
    expect(await findings(body)).toEqual(expected);
  });

  it("counts characters as UTF-16 code units", async () => {
    // Each emoji is two code units.
    const fill = (units: number) => `${RUN}# ${"😀".repeat((units - RUN.length - 2) / 2)}`;
    expect(await findings(fill(48_000))).toEqual([]);
    expect(await findings(fill(48_002))).toEqual([
      "size -:- 48002 characters, over the limit of 48000",
    ]);
  });

  it("reports both bounds at once, and parses nothing past them", async () => {
    const body = `async def run(inputs, ctx)\n${`# ${"x".repeat(150)}\n`.repeat(401)}`;
    expect(await findings(body)).toEqual([
      "size -:- 402 lines, over the limit of 400",
      `size -:- ${body.length} characters, over the limit of 48000`,
    ]);
  });
});

describe("syntax", () => {
  it.each([
    [
      "PEP 758's unparenthesized except",
      "try:\n    pass\nexcept ValueError, TypeError:\n    pass\n",
    ],
    ["a PEP 750 t-string", 't"hello {name}"\n'],
    ["\\r\\n line endings", "x = 1\r\ny = 2\r\n"],
  ])("accepts %s, which the vendored grammar parses", async (_label, prefix) => {
    expect(await findings(`${prefix}${RUN}`)).toEqual([]);
  });

  it("refuses a null tree, at the file", async () => {
    parser.nullTree = true;
    expect(await findings(RUN)).toEqual(["syntax -:- tree-sitter returned no tree"]);
  });

  it("refuses a PEP 696 type-parameter default, which the vendored grammar does not parse", async () => {
    expect(await findings(`def f[T = int](): pass\n${RUN}`)).toEqual([
      expect.stringMatching(/^syntax 1:7 tree-sitter cannot parse this/),
    ]);
  });

  it("locates a missing token the grammar shows", async () => {
    expect(await findings(`def f(:\n    pass\n${RUN}`)).toEqual([
      expect.stringMatching(/^syntax 1:7 /),
    ]);
  });

  it("locates a lone \\r between statements, whose missing newline has no node, at the block holding it", async () => {
    expect(await findings("async def run(inputs, ctx):\n    x = 1\r    return x\n")).toEqual([
      expect.stringMatching(/^syntax 2:5 /),
    ]);
  });

  it("counts a column in UTF-16 code units", async () => {
    // The emoji is two code units, four UTF-8 bytes and one code point.
    expect(await findings('async def run(inputs, ctx):\n    return {"e": "😀" + }\n')).toEqual([
      expect.stringMatching(/^syntax 2:23 /),
    ]);
  });
});

describe("entrypoint", () => {
  it.each([
    ["a `/` separator", "async def run(inputs, /, ctx):\n    pass\n"],
    ["a default value", "async def run(inputs, ctx=None):\n    pass\n"],
    [
      "annotations without models",
      "async def run(inputs: dict, ctx: object) -> dict:\n    return {}\n",
    ],
    [
      "a decorated Input class and the bare-name annotation",
      "@final\nclass Input:\n    pass\n\n\nasync def run(inputs: Input, ctx):\n    pass\n",
    ],
    ["a method named run", `class Helper:\n    def run(self):\n        pass\n\n\n${RUN}`],
    ["a local named run", `def helper():\n    run = 1\n    return run\n\n\n${RUN}`],
    ["a comprehension's run", `xs = [run for run in range(3)]\n\n\n${RUN}`],
    ["a module-level `global run`, which binds nothing", `global run\n${RUN}`],
    ["a dotted value pattern", `${RUN}match x:\n    case Mode.run:\n        pass\n`],
    ["a class pattern's class name", `${RUN}match x:\n    case run():\n        pass\n`],
    ["a keyword pattern's keyword", `${RUN}match x:\n    case Point(run=0):\n        pass\n`],
    ["a mapping pattern's dotted key", `${RUN}match x:\n    case {Mode.run: 1}:\n        pass\n`],
    ["a wildcard", `${RUN}match x:\n    case _:\n        pass\n`],
  ])("accepts %s", async (_label, body) => {
    expect(await findings(body)).toEqual([]);
  });

  it.each([
    ["an annotated assignment", "run: object\n", "1:1"],
    ["an augmented assignment", "run += 1\n", "1:1"],
    ["an unpacking", "a, *run = (1, 2)\n", "1:5"],
    ["a for target", "for run in []:\n    pass\n", "1:5"],
    ["a with target", "with open('x') as run:\n    pass\n", "1:19"],
    ["an except target", "try:\n    pass\nexcept Exception as run:\n    pass\n", "3:21"],
    ["a named expression", "(run := 1)\n", "1:2"],
    ["an import", "import run\n", "1:8"],
    ["a chained assignment", "a = run = 1\n", "1:5"],
    ["a global in a class body", "class C:\n    global run\n", "2:12"],
    ["a match capture", "match x:\n    case run:\n        pass\n", "2:10"],
    ["a nested match capture", "match x:\n    case [a, (b, run)]:\n        pass\n", "2:18"],
    ["a sequence pattern's star", "match x:\n    case [a, *run]:\n        pass\n", "2:15"],
    ["a mapping pattern's rest", "match x:\n    case {'k': 1, **run}:\n        pass\n", "2:21"],
    ["a mapping pattern's value", "match x:\n    case {'k': run}:\n        pass\n", "2:16"],
    ["a keyword pattern's value", "match x:\n    case Point(x=run):\n        pass\n", "2:18"],
    ["an or-pattern's alternative", "match x:\n    case 1 | run:\n        pass\n", "2:14"],
    ["a match as pattern", "match x:\n    case [1] as run:\n        pass\n", "2:17"],
  ])("refuses `run` bound by %s", async (_label, binding, at) => {
    expect(await findings(`${RUN}${binding}`)).toEqual([
      expect.stringMatching(
        new RegExp(
          `^entrypoint ${Number(at.split(":")[0]) + 2}:${at.split(":")[1]} \`run\` is rebound here`,
        ),
      ),
    ]);
  });

  it("refuses a second async def run, keeping the first", async () => {
    expect(await findings(`${RUN}${RUN}`)).toEqual([
      "entrypoint 3:1 `run` is defined more than once; keep one `async def run`",
    ]);
  });

  it("refuses a class named run", async () => {
    expect(await findings("class run:\n    pass\n")).toEqual([
      "entrypoint 1:1 `run` must be one undecorated `async def` directly at module level",
    ]);
  });

  it("reports every parameter rule run breaks, at the parameter list", async () => {
    expect(await findings("async def run(a, *args, k, **kw):\n    pass\n")).toEqual([
      "entrypoint 1:14 `run` takes no `*args`",
      "entrypoint 1:14 `run` takes no `**kwargs`",
      "entrypoint 1:14 `run` takes no keyword-only parameters",
      "entrypoint 1:14 `run` takes exactly two parameters, `inputs` and `ctx`; this one takes 4",
    ]);
  });

  it.each([
    ["an attribute", "models.Input"],
    ["a union", "Input | None"],
    ["a subscript", "Optional[Input]"],
  ])("refuses the Input annotation as %s", async (_label, annotation) => {
    const body = `class Input:\n    pass\n\n\nasync def run(inputs: ${annotation}, ctx):\n    pass\n`;
    expect(await findings(body)).toEqual([
      expect.stringMatching(/^entrypoint 5:23 `run`'s first parameter must be annotated `Input`/),
    ]);
  });

  it("refuses an Output return annotated by a string, at the annotation", async () => {
    const body = 'class Output:\n    pass\n\n\nasync def run(inputs, ctx) -> "Output":\n    pass\n';
    expect(await findings(body)).toEqual([
      expect.stringMatching(/^entrypoint 5:31 `run` must be annotated `-> Output`/),
    ]);
  });

  it("reads an Input class nested in a block as no model", async () => {
    expect(await findings(`if True:\n    class Input:\n        pass\n${RUN}`)).toEqual([]);
  });

  it("refuses `run` bound by a type statement", async () => {
    expect(await findings(`${RUN}type run = int\n`)).toEqual([
      expect.stringMatching(/^entrypoint 3:6 `run` is rebound here/),
    ]);
  });
});

describe("dynamic_code", () => {
  it.each([
    ["re.compile", `import re\n\nPATTERN = re.compile("a+")\n${RUN}`],
    ["a method named eval", `${RUN}x = obj.eval()\n`],
    ["a keyword argument named exec", `${RUN}x = f(exec=1)\n`],
    ["a definition named compile", `def compile():\n    pass\n${RUN}`],
    ["a parameter named eval", `def f(eval, *exec, **compile):\n    pass\n${RUN}`],
    ["a lambda parameter named eval", `f = lambda eval: 1\n${RUN}`],
    ["getattr with a literal name", `import os\n\nx = getattr(os, "sep")\n${RUN}`],
    ["getattr on a name no import binds", `x = getattr(obj, name)\n${RUN}`],
    [
      "getattr on the original of `import a as b`",
      `import os as o\n\nx = getattr(os, name)\n${RUN}`,
    ],
    [
      "getattr on a module from `from … import`",
      `from os import path\n\nx = getattr(path, name)\n${RUN}`,
    ],
    ["importlib.util", `import importlib.util\n\nx = importlib.util.find_spec("x")\n${RUN}`],
    ["import_module on a name not bound to importlib", `x = loader.import_module("x")\n${RUN}`],
    ["__builtins__ subscripted, which passes", `x = __builtins__["e" + "val"]\n${RUN}`],
    ["a from-import of re.compile under an alias", `from re import compile as regex\n${RUN}`],
    ["an import aliased eval", `import os as eval\n${RUN}`],
    [
      "eval as a dotted value pattern's last name",
      `${RUN}match x:\n    case enum.Mode.eval:\n        pass\n`,
    ],
    [
      "compile as a keyword pattern's keyword",
      `${RUN}match x:\n    case Foo(compile=1):\n        pass\n`,
    ],
  ])("accepts %s", async (_label, body) => {
    expect(await findings(body)).toEqual([]);
  });

  it.each([
    [
      "the skill's own compile, called",
      `def compile():\n    pass\n\n\nx = compile()\n${RUN}`,
      "5:5",
      "`compile`",
    ],
    ["eval passed as a value", `x = f(key=eval)\n${RUN}`, "1:11", "`eval`"],
    ["__builtins__.eval", `x = __builtins__.eval\n${RUN}`, "1:5", "`__builtins__.eval`"],
    [
      "importlib.__import__",
      `import importlib\n\nx = importlib.__import__("os")\n${RUN}`,
      "3:5",
      "`importlib.__import__`",
    ],
    [
      "importlib bound by a dotted import",
      `import importlib.util\n\nx = importlib.import_module(n)\n${RUN}`,
      "3:5",
      "`importlib.import_module`",
    ],
    [
      "getattr on a dotted import's root",
      `import os.path\n\nx = getattr(os, name)\n${RUN}`,
      "3:5",
      "`getattr`",
    ],
  ])("refuses %s", async (_label, body, at, name) => {
    expect(await findings(body)).toEqual([
      expect.stringMatching(new RegExp(`^dynamic_code ${at} ${name}`)),
    ]);
  });

  it("refuses a from-import of a builtin that runs code at the alias and each use", async () => {
    const body = `from builtins import eval as e\n\nx = e("1")\n${RUN}`;
    expect(await findings(body)).toEqual([
      expect.stringMatching(/^dynamic_code 1:30 `e` runs code built at run time/),
      expect.stringMatching(/^dynamic_code 3:5 `e` runs code built at run time/),
    ]);
  });

  it("refuses a use of compile a from-import binds, not the import", async () => {
    const body = `from re import compile\n\nx = compile("a")\n${RUN}`;
    expect(await findings(body)).toEqual([expect.stringMatching(/^dynamic_code 3:5 `compile`/)]);
  });

  it("refuses an aliased from-import of import_module at the alias and each use", async () => {
    const body = `from importlib import import_module as im\n\nx = im("os")\n${RUN}`;
    expect(await findings(body)).toEqual([
      expect.stringMatching(/^dynamic_code 1:40 `im` imports a module named at run time/),
      expect.stringMatching(/^dynamic_code 3:5 `im`/),
    ]);
  });
});

describe("effects", () => {
  const network = (allow: string[], secrets: SkillManifest["secrets"]) =>
    manifestWith({ network: { allow }, secrets });
  const calling = (call: string) => `async def run(inputs, ctx):\n    await ${call}\n`;

  it.each([
    ["an escape sequence in the URL", 'ctx.http.get("https://evil\\x2eorg/")'],
    ["an f-string's {{ in the URL", 'ctx.http.get(f"https://evil.org/{{x}}")'],
    ["an f-string whose host is a replacement field", 'ctx.http.get(f"https://{host}/x")'],
    [
      "an f-string whose literal text does not end the authority",
      'ctx.http.get(f"https://evil.org{path}")',
    ],
    [
      "an f-string with userinfo before its field",
      'ctx.http.get(f"https://api.example.com@{host}/")',
    ],
    ["a URL in a variable", "ctx.http.get(url)"],
    ["a URL after a * unpacking", 'ctx.http.request(*args, "https://evil.org/")'],
    ["a ctx.http method cogmo_ctx lacks", 'ctx.http.put("https://evil.org/")'],
    ["a receiver bound by assignment", 'client.http.get("https://evil.org/")'],
    ["a secret name in a variable", "ctx.secrets.get(name)"],
    ["a secret name with an escape", 'ctx.secrets.get("ot\\x68er")'],
    ["a declared bound secret", 'ctx.secrets.get("bound")'],
    ["a host under an allowed zone at depth", 'ctx.http.get("https://a.b.example.com/")'],
    ["a host matching an entry in another case", 'ctx.http.get("https://API.EXAMPLE.ORG/")'],
    [
      "an f-string with an empty authority, whose host the field supplies",
      'ctx.http.get(f"https:///{inputs}/path")',
    ],
    [
      "an f-string whose authority does not parse, left to the run",
      'ctx.http.get(f"https://api.example.com:99999/{x}")',
    ],
    [
      "a comprehension target shadowing ctx",
      '[ctx.http.get("https://evil.org/") for ctx in inputs]',
    ],
  ])("accepts %s", async (_label, call) => {
    const manifest = network(
      ["api.example.com", "*.example.com", "Api.Example.Org"],
      [{ name: "bound", binding: { destination: "https://api.example.com/*" } }],
    );
    expect(await findingsUnder(manifest, calling(call))).toEqual([]);
  });

  it.each([
    [
      "a raw string, whose text is its value",
      'ctx.http.get(r"https://evil.org/x")',
      "'evil.org' is not in",
    ],
    [
      "the apex of an allowed zone",
      'ctx.http.get("https://example.com/")',
      "'example.com' is not in",
    ],
    ["a file URL", 'ctx.http.get("file:///etc/passwd")', "supports http and https, got 'file:'"],
    ["an f-string with a non-http scheme", 'ctx.http.get(f"ftp://h/{x}")', "got 'ftp:'"],
    [
      "a port out of range",
      'ctx.http.get("https://api.example.com:99999/")',
      "could not parse url",
    ],
    ["a post to a host outside network.allow", 'ctx.http.post("https://evil.org/")', "'evil.org'"],
  ])("refuses %s", async (_label, call, message) => {
    expect(
      await findingsUnder(network(["api.example.com", "*.example.com"], []), calling(call)),
    ).toEqual([
      expect.stringMatching(new RegExp(`^effects 2:\\d+ .*${message.replace(/[()]/g, "\\$&")}`)),
    ]);
  });

  it("does not read a method's first parameter as a ctx receiver", async () => {
    const body = `${RUN}class Fetcher:\n    async def go(self):\n        return await self.http.get("https://evil.org/")\n`;
    expect(await findingsUnder(network(["api.example.com"], []), body)).toEqual([]);
  });

  it("reports each call it refuses", async () => {
    const body = `async def run(inputs, ctx):\n    await ctx.secrets.get("a")\n    await ctx.http.get("https://evil.org/")\n`;
    expect(await findingsUnder(network(["api.example.com"], []), body)).toEqual([
      "effects 2:27 secret 'a' is not declared in SKILL.md frontmatter",
      "effects 3:24 'evil.org' is not in this skill's network.allow list",
    ]);
  });
});

describe("the stage after the gates", () => {
  it("reads the tree the gates parsed, with its ctx calls", async () => {
    const body = 'async def run(inputs, ctx):\n    await ctx.files.read("a")\n';
    const read = vi.fn((tree: SkillTree) => tree.ctxCalls.map((c) => `${c.namespace}.${c.method}`));
    const gated = await runSkillGates({ name: "echo", manifest: WASM, body }, read);
    expect(gated._unsafeUnwrap()).toEqual(["files.read"]);
    expect(read).toHaveBeenCalledOnce();
  });

  it.each([
    ["a size finding", `${RUN}${"# pad\n".repeat(399)}`],
    ["a syntax finding", `def f(:\n${RUN}`],
    ["a third-stage finding", 'async def run(inputs, ctx):\n    eval("1")\n'],
  ])("does not run after %s", async (_label, body) => {
    const read = vi.fn();
    const gated = await runSkillGates({ name: "echo", manifest: WASM, body }, read);
    expect(gated.isErr()).toBe(true);
    expect(read).not.toHaveBeenCalled();
  });

  it("does not run on a null tree", async () => {
    parser.nullTree = true;
    const read = vi.fn();
    expect((await runSkillGates({ name: "echo", manifest: WASM, body: RUN }, read)).isErr()).toBe(
      true,
    );
    expect(read).not.toHaveBeenCalled();
  });
});

describe("deep and long bodies", () => {
  // Timed on a loaded parser, bounded far below the seconds a walk quadratic in
  // the body's calls takes at the line bound.
  beforeAll(loadPythonParser);

  /** `x = (a0 + a1 + …)` over `terms` terms, 21 to a line. */
  const chain = (terms: number) => {
    const names = Array.from({ length: terms }, (_, i) => `a${i}`);
    const rows = R.chunk(names, 21).map((row) => `    ${row.join(" + ")}`);
    return `${RUN}x = (\n${rows.join(" +\n")}\n)\n`;
  };

  /** A valid `run` reading `lines - 3` response headers, each a call on a non-ctx receiver. */
  const headers = (lines: number) =>
    [
      "import urllib.parse",
      "async def run(inputs, ctx):",
      '    resp = await ctx.http.get("https://api.example.com/")',
      ...R.times(
        lines - 3,
        (i) => `    v${i} = urllib.parse.quote(resp.headers.get("x-${i}", ""))`,
      ),
      "",
    ].join("\n");

  it("gates a 2000-term chain without overflowing the stack", async () => {
    const started = performance.now();
    expect(await findings(chain(2000))).toEqual([]);
    expect(performance.now() - started).toBeLessThan(5000);
  });

  it("gates a body at the line bound in well under the walk's quadratic time", async () => {
    const body = headers(400);
    expect(body.split("\n").length - 1).toBe(400);
    expect(body.length).toBeLessThan(48_000);

    const started = performance.now();
    expect(await gate(body, manifestWith({ network: { allow: ["api.example.com"] } }))).toEqual([]);
    expect(performance.now() - started).toBeLessThan(5000);
  });
});

describe("the third stage", () => {
  it("runs wasm-lint on the wasm tier only, a line and no column", async () => {
    const body = `import subprocess\n${RUN}`;
    expect(await gate(body, WASM)).toEqual([
      expect.objectContaining({ id: "wasm_lint", line: 1, column: null }),
    ]);
    expect(await gate(body, manifestWith({ tier: "container" }))).toEqual([]);
  });

  it("orders the gates entrypoint, dynamic code, effects, wasm-lint", async () => {
    const body =
      'import socket\n\n\ndef run(inputs, ctx):\n    eval("1")\n    ctx.secrets.get("x")\n';
    expect((await gate(body, WASM)).map((f) => f.id)).toEqual([
      "entrypoint",
      "dynamic_code",
      "effects",
      "wasm_lint",
    ]);
  });
});
