import { readFileSync } from "node:fs";
import { join } from "node:path";
import { z } from "zod";
import { RUNTIME_PACKAGES } from "./runtime-packages.js";
import { SKILLS_VERIFY_COMMAND } from "./toolchain.js";
import { SKILL_EFFECTS, SkillManifestSchema } from "./types.js";

/**
 * The skills repo toolchain's generated files (design/skills.md → Verify
 * stage → The skills repo toolchain), relative to the repo root.
 * `pnpm --filter cogmo codegen:toolchain` writes them, and a unit test fails
 * when the checked-in copies differ.
 */
export const GENERATED_TOOLCHAIN_FILES = {
  pyproject: "images/skills/toolchain/pyproject.toml",
  claudeMd: "images/skills/toolchain/CLAUDE.md",
  manifestSchema: "images/skills/toolchain/.cogmo/skill.schema.json",
  paths: "images/skills/toolchain/.cogmo/paths",
} as const;

/** The header of each generated file, which lands in the skills repo, where cogmo's paths mean nothing. */
const GENERATED_BY = "Generated; do not edit.";

/** The toolchain's root entries, which `.cogmo/paths` lists. */
const TOOLCHAIN_ENTRIES = ["pyproject.toml", "uv.lock", "CLAUDE.md", ".gitignore", ".cogmo"];

/**
 * The dev group's tools, pinned exactly and bumped by hand, followed by
 * `uv lock` in `images/skills/toolchain/`. pydantic joins them from
 * `RUNTIME_PACKAGES`.
 */
const TOOL_PINS: Readonly<Record<string, string>> = {
  pyrefly: "1.4.0",
  pytest: "9.2.0",
  "pytest-asyncio": "1.4.1",
  ruff: "0.17.3",
};

/** The verify stage's ruff rule set (design/skills.md → Verify stage, Types and lint). */
const RUFF_RULES = ["E", "F", "B", "BLE", "S", "ASYNC"];

/** The pins `pyproject.toml` derives from the skills image's build. */
export interface ToolchainPins {
  /** The image's uv, `docker-bake.hcl`'s `UV_VERSION` default. */
  uvVersion: string;
  /** The image's Python minor, `images/skills/.python-version`. */
  pythonMinor: string;
  /** The image's exact Python, from `images/skills/Dockerfile`'s final `FROM`. */
  pythonVersion: string;
}

/** Read {@link ToolchainPins} from the repo at `repoRoot`. */
export function readToolchainPins(repoRoot: string): ToolchainPins {
  const bake = readFileSync(join(repoRoot, "docker-bake.hcl"), "utf8");
  const uvVersion = /variable\s+"UV_VERSION"\s*\{\s*default\s*=\s*"([^"]+)"/.exec(bake)?.[1];
  if (uvVersion === undefined) throw new Error("docker-bake.hcl declares no UV_VERSION default");
  const pythonMinor = readFileSync(join(repoRoot, "images/skills/.python-version"), "utf8").trim();
  if (!/^\d+\.\d+$/.test(pythonMinor)) {
    throw new Error(`images/skills/.python-version holds '${pythonMinor}', not a Python minor`);
  }
  const dockerfile = readFileSync(join(repoRoot, "images/skills/Dockerfile"), "utf8");
  const finalFrom = dockerfile.split("\n").findLast((line) => /^FROM\s/i.test(line)) ?? "";
  const pythonVersion = /\bpython:(\d+\.\d+\.\d+)-slim\b/.exec(finalFrom)?.[1];
  if (pythonVersion === undefined) {
    throw new Error(
      `images/skills/Dockerfile's final FROM names no python:<X.Y.Z>-slim image: ${finalFrom}`,
    );
  }
  if (!pythonVersion.startsWith(`${pythonMinor}.`)) {
    throw new Error(
      `images/skills/Dockerfile's final FROM runs Python ${pythonVersion}, not on .python-version's ${pythonMinor}`,
    );
  }
  return { uvVersion, pythonMinor, pythonVersion };
}

/**
 * The toolchain's `pyproject.toml`: a virtual project whose dev group is the
 * tools `.cogmo/verify` runs and the runtime's pydantic, uv pinned to the
 * image's, and `[tool.uv.pip]` set so an author's plain `uv pip compile`
 * writes register's lockfile bytes: register's compile runs on the image's
 * interpreter, so the author's resolves for its exact version.
 */
export function renderToolchainPyproject(pins: ToolchainPins): string {
  const dev = Object.entries({ ...TOOL_PINS, pydantic: RUNTIME_PACKAGES.pydantic })
    .sort(([a], [b]) => (a < b ? -1 : 1))
    .map(([name, version]) => `    "${name}==${version}",`);
  return [
    `# ${GENERATED_BY}`,
    "",
    "[project]",
    'name = "cogmo-skills"',
    'version = "0"',
    `requires-python = "==${pins.pythonMinor}.*"`,
    "dependencies = []",
    "",
    "[dependency-groups]",
    "dev = [",
    ...dev,
    "]",
    "",
    "[tool.uv]",
    "package = false",
    `required-version = "==${pins.uvVersion}"`,
    "",
    "[tool.uv.pip]",
    `python-version = "${pins.pythonVersion}"`,
    "generate-hashes = true",
    "no-header = true",
    "",
    "[tool.ruff]",
    "line-length = 120",
    'extend-exclude = [".cogmo"]',
    "",
    "[tool.ruff.lint]",
    `select = [${RUFF_RULES.map((rule) => `"${rule}"`).join(", ")}]`,
    "",
    "[tool.ruff.lint.per-file-ignores]",
    '"**/test_skill.py" = ["S101"]',
    "",
    "[tool.pyrefly]",
    'search-path = [".cogmo"]',
    "",
    "[tool.pytest.ini_options]",
    'pythonpath = [".cogmo"]',
    'asyncio_mode = "auto"',
    'asyncio_default_fixture_loop_scope = "function"',
    "",
  ].join("\n");
}

type JsonSchema = Record<string, unknown>;

function isSchema(value: unknown): value is JsonSchema {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/** The frontmatter's JSON Schema: what an author writes, so defaults leave fields optional. */
function manifestSchema(): JsonSchema {
  const { $schema: _dialect, ...rest } = z.toJSONSchema(SkillManifestSchema, { io: "input" });
  return rest;
}

/** `.cogmo/skill.schema.json`: the JSON Schema of `SKILL.md`'s frontmatter. */
export function renderSkillManifestSchema(): string {
  const document = {
    $schema: "https://json-schema.org/draft/2020-12/schema",
    $comment: GENERATED_BY,
    title: "SKILL.md frontmatter",
    ...manifestSchema(),
  };
  return `${JSON.stringify(document, null, 2)}\n`;
}

/** `.cogmo/paths`: the toolchain's root entries, one per line. */
export function renderToolchainPaths(): string {
  return `${TOOLCHAIN_ENTRIES.join("\n")}\n`;
}

/** What a frontmatter field means beyond its shape, keyed by field. */
const FIELD_NOTES: Readonly<Record<string, string>> = {
  name: "The skill's directory, `skills/<name>/`.",
  description: "The model reads it to choose the skill.",
  tier: "`wasm` runs in Pyodide and installs only pure-Python wheels.",
  isolation: "Container tier only.",
  schedule: "A cron expression; required with the `cron` trigger.",
  inputs: "Only for a skill without an `Input` model, which is otherwise the one source.",
  outputs: "Only for a skill without an `Output` model, which is otherwise the one source.",
  effects: "Every effect the code has, from the list below.",
  secrets: "The names the code reads with `ctx.secrets.get`.",
  dependencies: "Direct dependencies, each pinned exactly.",
  network: "The hosts `ctx.http` may reach; none when absent.",
};

function code(value: string): string {
  return `\`${value}\``;
}

function listOf(values: readonly unknown[]): string {
  return values.map((value) => code(String(value))).join(", ");
}

/** A field's shape in words, from its JSON Schema. */
function describeShape(name: string, schema: JsonSchema): string {
  const { type, items, properties } = schema;
  if (Array.isArray(schema.enum)) return `one of ${listOf(schema.enum)}`;
  if (type === "string") {
    const pattern = typeof schema.pattern === "string" ? ` matching ${code(schema.pattern)}` : "";
    const { minLength, maxLength } = schema;
    const length =
      typeof maxLength === "number"
        ? `, ${typeof minLength === "number" ? `${minLength} to ` : "at most "}${maxLength} characters`
        : "";
    return `a string${pattern}${length}`;
  }
  if (type === "number") {
    return typeof schema.minimum === "number" ? `a number, at least ${schema.minimum}` : "a number";
  }
  if (type === "array" && isSchema(items)) {
    if (name === "effects") return "a list of effects";
    if (Array.isArray(items.enum)) return `a list of ${listOf(items.enum)}`;
    if (items.type === "string" && typeof items.pattern === "string") {
      return `a list of strings matching ${code(items.pattern)}`;
    }
    return "a list";
  }
  if (type === "object") {
    return isSchema(properties) ? `an object with ${listOf(Object.keys(properties))}` : "an object";
  }
  throw new Error(`the frontmatter field ${name} has a shape CLAUDE.md cannot describe`);
}

/** One line per frontmatter field: its shape, default and note. */
function frontmatterFields(): string[] {
  const schema = manifestSchema();
  const { properties } = schema;
  if (!isSchema(properties)) throw new Error("the frontmatter schema has no properties");
  const required = new Set(Array.isArray(schema.required) ? schema.required : []);
  const unknownNotes = Object.keys(FIELD_NOTES).filter((name) => !(name in properties));
  if (unknownNotes.length > 0) {
    throw new Error(`CLAUDE.md notes fields the frontmatter lacks: ${unknownNotes.join(", ")}`);
  }
  return Object.entries(properties).map(([name, field]) => {
    if (!isSchema(field)) throw new Error(`the frontmatter field ${name} has no schema`);
    const fallback = "default" in field ? `; default ${code(JSON.stringify(field.default))}` : "";
    const note = FIELD_NOTES[name];
    return [
      `- ${code(name)}${required.has(name) ? " (required)" : ""}: ${describeShape(name, field)}${fallback}.`,
      ...(note === undefined ? [] : [note]),
    ].join(" ");
  });
}

/**
 * The skills repo's `CLAUDE.md`: the authoring convention, its frontmatter
 * fields from `SkillManifestSchema`, its effects from `SKILL_EFFECTS`, and
 * the check that must pass, the repo's `verify_command`.
 */
export function renderToolchainClaudeMd(): string {
  const owned = TOOLCHAIN_ENTRIES.map((entry) => code(entry === ".cogmo" ? ".cogmo/" : entry));
  return [
    `<!-- ${GENERATED_BY} -->`,
    "",
    "# Cogmo skills",
    "",
    "Cogmo's skill library. A branch deploys one skill: it changes that skill's files and nothing else.",
    "",
    "## Layout",
    "",
    "Each skill is a directory `skills/<name>/` holding only:",
    "",
    "- `SKILL.md`: YAML frontmatter, then a body saying when to use the skill.",
    "- `skill.py`: the entrypoint.",
    "- `requirements.lock`: the lockfile, when the skill declares dependencies.",
    "- `test_skill.py`: a pytest test for each example, and one for a failure.",
    "",
    `Cogmo owns ${owned.slice(0, -1).join(", ")} and ${owned.at(-1)}, and replaces them on each release. They are read-only: a branch that changes one is refused.`,
    "",
    "## skill.py",
    "",
    "```python",
    "from pydantic import BaseModel",
    "",
    "from cogmo_ctx import Ctx, SkillError",
    "",
    "",
    "class Input(BaseModel):",
    "    city: str",
    "",
    "",
    "class Output(BaseModel):",
    "    summary: str",
    "",
    "",
    "async def run(inputs: Input, ctx: Ctx) -> Output: ...",
    "```",
    "",
    "- `Input` and `Output` are the skill's contract: register derives the tool's schemas from them.",
    "- Raise `SkillError(kind, message)` for an expected failure, with `retryable=True` when a later attempt may succeed (an outage, a rate limit). Never catch an exception to return success: any other exception is a defect.",
    '- Reach the outside only through `ctx`. A write request through `ctx.http` sends `ctx.run()["key"]` as its `Idempotency-Key` header, so a retry cannot act twice.',
    "",
    "## SKILL.md frontmatter",
    "",
    "`.cogmo/skill.schema.json` is its JSON Schema.",
    "",
    ...frontmatterFields(),
    "",
    "Effects:",
    "",
    ...SKILL_EFFECTS.map((effect) => `- ${code(effect)}`),
    "",
    "## Dependencies",
    "",
    "List each direct dependency as `name==version` under `dependencies`, then write the lockfile from the repo root:",
    "",
    "```sh",
    "printf '%s\\n' httpx==0.27.0 | uv pip compile - > skills/<name>/requirements.lock",
    "```",
    "",
    `\`pyproject.toml\` supplies \`--generate-hashes\`, \`--no-header\` and the image's Python version, so the output matches register's own compile byte for byte. Skills share the runtime's pydantic: when a dependency needs it, also declare \`pydantic==${RUNTIME_PACKAGES.pydantic}\`. Do not run \`uv add\` or \`uv lock\`: the project's dependencies are Cogmo's tools, not the skill's.`,
    "",
    "## Checks",
    "",
    `${code(SKILLS_VERIFY_COMMAND)} runs ruff, pyrefly and pytest over each skill changed since \`COGMO_VERIFY_BASE\`, the commit the branch was cut from. It must pass before the work is done.`,
    "",
  ].join("\n");
}
