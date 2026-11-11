/**
 * The parity table of register's step 4 and the gates CLI (design/skills.md →
 * The gates in verify → Parity). `check-skill-files.test.ts` runs each case
 * through `checkSkillFiles`, as register calls it, and `gates-cli.test.ts`
 * through the bundle under `node`, so the two agree on every case here.
 */

/** A skill's two files and what register's step 4 and the CLI make of them. */
export interface GatesCase {
  label: string;
  /** The skill's directory, `skills/<name>/`. */
  name: string;
  /** `SKILL.md`'s text, or null where it is absent. */
  manifest: string | null;
  /** `skill.py`'s text, or null where it is absent. */
  body: string | null;
  /** The strings `RegisterResult.errors` carries, in order: one line each on the CLI's stdout. */
  lines: readonly string[];
  /** 0 when every check passes, 1 on a refusal. */
  exit: 0 | 1;
}

/** `SKILL.md` of a skill under `skills/echo/`, its frontmatter extended by `extra`. */
function manifest(tier: "wasm" | "container", extra: string): string {
  return `---
name: echo
description: a skill that echoes its inputs back
tier: ${tier}
inputs:
  type: object
  properties: {}
${extra}---
`;
}

const WASM = manifest("wasm", "");

/** The container tier, where `wasm-lint` does not run and `smtplib` reaches the classifier. */
const CONTAINER = manifest("container", "");

const NETWORK = manifest(
  "wasm",
  `network:
  allow:
    - api.example.com
secrets:
  - api_key
`,
);

const RUN = "async def run(inputs, ctx):\n    return {}\n";

/** `n` comment lines, each 6 characters with its newline. */
function pad(n: number): string {
  return "# pad\n".repeat(n);
}

const PATH = "skills/echo/skill.py";

const SYNTAX_MESSAGE =
  "tree-sitter cannot parse this: a syntax error, or syntax newer than the vendored Python grammar";

export const GATES_CASES: readonly GatesCase[] = [
  { label: "a pass", name: "echo", manifest: WASM, body: RUN, lines: [], exit: 0 },
  {
    label: "a container-tier pass reading memory it declares",
    name: "echo",
    manifest: manifest("container", "effects:\n  - reads_memory\n"),
    body: 'async def run(inputs, ctx):\n    return await ctx.memory.recall("q")\n',
    lines: [],
    exit: 0,
  },
  {
    label: "no SKILL.md, whatever skill.py is",
    name: "echo",
    manifest: null,
    body: null,
    lines: ["missing_skill_md: skills/echo/SKILL.md not found"],
    exit: 1,
  },
  {
    label: "no skill.py",
    name: "echo",
    manifest: WASM,
    body: null,
    lines: ["missing_skill_py: skills/echo/skill.py not found"],
    exit: 1,
  },
  {
    label: "a manifest with no frontmatter",
    name: "echo",
    manifest: "# echo\n",
    body: RUN,
    lines: ["SKILL.md must start with a YAML frontmatter block delimited by '---' lines"],
    exit: 1,
  },
  {
    label: "a manifest whose YAML does not parse, its code frame one string",
    name: "echo",
    manifest: "---\nname: [echo\n---\n",
    body: RUN,
    lines: [
      "Flow sequence in block collection must be sufficiently indented and end with a ] at line 1, column 12:\n\nname: [echo\n           ^\n",
    ],
    exit: 1,
  },
  {
    label: "a manifest the schema refuses, one issue per string",
    name: "echo",
    manifest: "---\nname: echo\ndescription: short\ntier: lambda\n---\n",
    body: RUN,
    lines: [
      "description: Too small: expected string to have >=10 characters",
      'tier: Invalid option: expected one of "wasm"|"container"',
    ],
    exit: 1,
  },
  {
    label: "a manifest naming another skill",
    name: "echo",
    manifest: WASM.replace("name: echo", "name: other"),
    body: RUN,
    lines: [
      "skill_name_mismatch: skills/echo/SKILL.md names the skill 'other'; its directory must be skills/other/",
    ],
    exit: 1,
  },
  {
    label: "size: over the line bound, which hides the parse",
    name: "echo",
    manifest: WASM,
    body: `def run(:\n${RUN}${pad(999)}`,
    lines: [`size: ${PATH}: 1002 lines, over the limit of 1000`],
    exit: 1,
  },
  {
    label: "size: over the character bound",
    name: "echo",
    manifest: WASM,
    body: `${RUN}# ${"x".repeat(120_000)}\n`,
    lines: [`size: ${PATH}: 120045 characters, over the limit of 120000`],
    exit: 1,
  },
  {
    label: "syntax: an error, which hides the third stage",
    name: "echo",
    manifest: WASM,
    body: 'eval("1")\ndef run(:\n    pass\n',
    lines: [`syntax: ${PATH}:2:9: ${SYNTAX_MESSAGE}`],
    exit: 1,
  },
  {
    label: "entrypoint: no run, which hides the classifier",
    name: "echo",
    manifest: CONTAINER,
    body: "import smtplib\n",
    lines: [
      `entrypoint: ${PATH}: skill.py binds no \`run\`; define \`async def run(inputs, ctx)\` directly at module level`,
    ],
    exit: 1,
  },
  {
    label: "entrypoint: a synchronous run with one parameter",
    name: "echo",
    manifest: WASM,
    body: "def run(inputs):\n    return {}\n",
    lines: [
      `entrypoint: ${PATH}:1:1: \`run\` must be one undecorated \`async def\` directly at module level`,
    ],
    exit: 1,
  },
  {
    label: "dynamic_code: eval",
    name: "echo",
    manifest: WASM,
    body: 'async def run(inputs, ctx):\n    return eval("{}")\n',
    lines: [
      `dynamic_code: ${PATH}:2:12: \`eval\` runs code built at run time; keep the code static`,
    ],
    exit: 1,
  },
  {
    label: "effects: a host outside network.allow and an undeclared secret",
    name: "echo",
    manifest: NETWORK,
    body: 'async def run(inputs, ctx):\n    await ctx.secrets.get("other_key")\n    return await ctx.http.get("https://evil.example.org/")\n',
    lines: [
      `effects: ${PATH}:2:27: secret 'other_key' is not declared in SKILL.md frontmatter`,
      `effects: ${PATH}:3:31: 'evil.example.org' is not in this skill's network.allow list`,
    ],
    exit: 1,
  },
  {
    label: "wasm_lint: a line and no column",
    name: "echo",
    manifest: WASM,
    body: `import subprocess\n${RUN}`,
    lines: [
      `wasm_lint: ${PATH}:1: subprocess is not available in the wasm tier; declare tier: container`,
    ],
    exit: 1,
  },
  {
    label: "the third stage's gates together, in gate order",
    name: "echo",
    manifest: WASM,
    body: 'import subprocess\nasync def run(inputs, ctx, extra):\n    return eval("{}")\n',
    lines: [
      `entrypoint: ${PATH}:2:14: \`run\` takes exactly two parameters, \`inputs\` and \`ctx\`; this one takes 3`,
      `dynamic_code: ${PATH}:3:12: \`eval\` runs code built at run time; keep the code static`,
      `wasm_lint: ${PATH}:1: subprocess is not available in the wasm tier; declare tier: container`,
    ],
    exit: 1,
  },
  {
    label: "a classifier refusal: its validation errors as one string",
    name: "echo",
    manifest: CONTAINER,
    body: 'import smtplib\nasync def run(inputs, ctx):\n    await ctx.memory.recall("q")\n    return {}\n',
    lines: [
      "undeclared effect 'sends_email' — code uses smtplib but manifest does not declare it; undeclared effect 'reads_memory' — code uses ctx.memory.recall but manifest does not declare it",
    ],
    exit: 1,
  },
  {
    label: "a column after non-ASCII text, in UTF-16 code units",
    name: "echo",
    manifest: WASM,
    body: 'async def run(inputs, ctx):\n    note = "naïve 😀"; return eval(note)\n',
    lines: [
      `dynamic_code: ${PATH}:2:31: \`eval\` runs code built at run time; keep the code static`,
    ],
    exit: 1,
  },
  {
    label: "a \\r\\n body, each line ending once",
    name: "echo",
    manifest: WASM,
    body: 'x = 1\r\ny = 2\r\nasync def run(inputs, ctx):\r\n    return eval("{}")\r\n',
    lines: [
      `dynamic_code: ${PATH}:4:12: \`eval\` runs code built at run time; keep the code static`,
    ],
    exit: 1,
  },
];

/** A `SKILL.md` and what `--dependencies` makes of it, or `declaredDependencyNames`. */
export interface DependenciesCase {
  label: string;
  manifest: string | null;
  /** The names, PEP 503-normalized and each once, for exit 0; the refusal's strings for exit 1. */
  lines: readonly string[];
  exit: 0 | 1;
}

export const DEPENDENCIES_CASES: readonly DependenciesCase[] = [
  {
    label: "declared names, normalized and each once",
    manifest: manifest(
      "wasm",
      "dependencies:\n  - Requests==2.32.3\n  - python_dateutil==2.9.0\n  - requests==2.32.3\n",
    ),
    lines: ["requests", "python-dateutil"],
    exit: 0,
  },
  { label: "none declared", manifest: WASM, lines: [], exit: 0 },
  {
    label: "a manifest that does not parse",
    manifest: "---\nname: echo\ndescription: short\ntier: wasm\n---\n",
    lines: ["description: Too small: expected string to have >=10 characters"],
    exit: 1,
  },
  {
    label: "no SKILL.md",
    manifest: null,
    lines: ["missing_skill_md: skills/echo/SKILL.md not found"],
    exit: 1,
  },
];
