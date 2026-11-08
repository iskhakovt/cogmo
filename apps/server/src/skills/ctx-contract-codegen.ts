import * as R from "remeda";
import { z } from "zod";
import { CTX_CONTRACT, CtxErrorKindSchema } from "./ctx-contract.js";
import {
  CtxCallSchema,
  CtxResultSchema,
  SupervisorReadySchema,
  TaskExitedSchema,
  TaskInvokeSchema,
  TaskResultSchema,
} from "./protocol.js";
import { RUNTIME_FLOORS, RUNTIME_PACKAGES } from "./runtime-packages.js";

/**
 * The files generated from the ctx contract, the worker protocol's Zod
 * schemas and the runtime's pydantic pins (design/skills.md → Contracts),
 * relative to the repo root.
 * `pnpm --filter cogmo codegen:ctx` writes them, and a unit test fails when
 * the checked-in copies differ.
 */
export const GENERATED_CONTRACT_FILES = {
  schema: "images/skills/contract/worker-protocol.schema.json",
  python: "images/skills/src/cogmo_ctx/_contract.py",
  runtimePackages: "images/skills/contract/runtime-packages.json",
} as const;

const GENERATED_BY =
  "Generated from apps/server/src/skills by `pnpm --filter cogmo codegen:ctx`. Do not edit.";

type JsonSchema = Record<string, unknown>;

/**
 * `schema` in JSON Schema's output mode (Zod's default), which closes each
 * object to the keys it names: the checks that a frame carries no key the
 * host would strip rely on it.
 */
function schemaOf(schema: z.ZodType): JsonSchema {
  const { $schema: _dialect, ...rest } = z.toJSONSchema(schema);
  return rest;
}

/**
 * The worker protocol frames Python sends or reads, and each ctx method's
 * arguments and result, as one JSON Schema document whose `$defs` the
 * Python side's frames are checked against. The wasm worker's `ready` and
 * `fatal` frames are left out: the host's JavaScript writes them.
 */
export function renderContractSchema(): string {
  const frames = {
    task_invoke: TaskInvokeSchema,
    task_result: TaskResultSchema,
    ctx_call: CtxCallSchema,
    ctx_result: CtxResultSchema,
    task_exited: TaskExitedSchema,
    supervisor_ready: SupervisorReadySchema,
  };
  const methods = R.entries(CTX_CONTRACT).flatMap(([method, { args, result }]) => [
    [`ctx.${method}.args`, schemaOf(args)] as const,
    [`ctx.${method}.result`, schemaOf(result)] as const,
  ]);
  const document = {
    $schema: "https://json-schema.org/draft/2020-12/schema",
    $comment: GENERATED_BY,
    $defs: {
      ...R.mapValues(frames, schemaOf),
      CtxErrorKind: schemaOf(CtxErrorKindSchema),
      ...Object.fromEntries(methods),
    },
  };
  return `${JSON.stringify(document, null, 2)}\n`;
}

/** What `cogmo_ctx/_contract.py` is generated from. */
export interface PythonContractSource {
  /** Each ctx method's result, keyed by method name. */
  results: Readonly<Record<string, z.ZodType>>;
  errorKinds: readonly string[];
}

function isSchema(value: unknown): value is JsonSchema {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

const PYTHON_SCALARS: Record<string, string> = {
  string: "str",
  integer: "int",
  number: "float",
  boolean: "bool",
  null: "None",
};

/** Keys that describe a schema without constraining it. */
const ANNOTATIONS = new Set(["title", "description", "$comment"]);

/** A JSON scalar as a Python literal. */
function pythonLiteral(value: unknown): string {
  if (value === null) return "None";
  if (typeof value === "boolean") return value ? "True" : "False";
  if (typeof value === "string" || typeof value === "number") return JSON.stringify(value);
  throw new Error(`the ctx contract has a literal Python cannot write: ${JSON.stringify(value)}`);
}

function unmappable(schema: JsonSchema): Error {
  return new Error(`the ctx contract has a shape Python cannot type: ${JSON.stringify(schema)}`);
}

/**
 * The Python type for `schema`, declaring each object it reaches in
 * `declared` (title → `TypedDict` source) first, so a class follows the
 * classes it names. A shape it cannot map throws, as does an object with no
 * title or two different objects sharing one.
 */
function pythonType(schema: JsonSchema, declared: Map<string, string>): string {
  const { type, items, properties, additionalProperties, title } = schema;
  const members = schema.anyOf ?? schema.oneOf;
  if (Array.isArray(members)) {
    return members
      .map((member) => {
        if (!isSchema(member)) throw unmappable(schema);
        return pythonType(member, declared);
      })
      .join(" | ");
  }
  if (Array.isArray(schema.enum)) return `Literal[${schema.enum.map(pythonLiteral).join(", ")}]`;
  if ("const" in schema) return `Literal[${pythonLiteral(schema.const)}]`;
  if (Object.keys(schema).every((key) => ANNOTATIONS.has(key))) return "object";
  if (typeof type === "string" && PYTHON_SCALARS[type] !== undefined) return PYTHON_SCALARS[type];
  // A union of scalars, which Zod writes as one `type` array.
  if (Array.isArray(type)) {
    const scalars = type.flatMap((member) =>
      typeof member === "string" && PYTHON_SCALARS[member] !== undefined
        ? [PYTHON_SCALARS[member]]
        : [],
    );
    if (scalars.length === type.length) return scalars.join(" | ");
  }
  if (type === "array" && isSchema(items)) return `list[${pythonType(items, declared)}]`;
  if (type === "object" && !isSchema(properties) && isSchema(additionalProperties)) {
    return `dict[str, ${pythonType(additionalProperties, declared)}]`;
  }
  if (type !== "object" || !isSchema(properties)) throw unmappable(schema);
  if (typeof title !== "string") {
    throw new Error(`an object in the ctx contract has no title: ${JSON.stringify(schema)}`);
  }
  const required = new Set(Array.isArray(schema.required) ? schema.required : []);
  const fields = Object.entries(properties).map(([field, property]) => {
    if (!isSchema(property)) throw unmappable(schema);
    const fieldType = pythonType(property, declared);
    return `    ${field}: ${required.has(field) ? fieldType : `NotRequired[${fieldType}]`}`;
  });
  const source = `class ${title}(TypedDict):\n${fields.length > 0 ? fields.join("\n") : "    pass"}`;
  const earlier = declared.get(title);
  if (earlier !== undefined && earlier !== source) {
    throw new Error(`two objects in the ctx contract share the title ${title}`);
  }
  declared.set(title, source);
  return title;
}

/**
 * `cogmo_ctx/_contract.py` for `source`: `CtxErrorKind`, a `TypedDict` for
 * each object a method returns, and `Bridge`, whose `call` overloads give
 * each method its result type, so pyrefly checks `Ctx`'s signatures against
 * the contract. Written as ruff formats it, which CI checks.
 */
export function renderPythonModule(source: PythonContractSource): string {
  const declared = new Map<string, string>();
  const overloads = Object.entries(source.results).map(([method, result]) => {
    const returns = pythonType(schemaOf(result), declared);
    return [
      "    @overload",
      `    async def call(self, method: Literal["${method}"], args: Mapping[str, object]) -> ${returns}: ...`,
    ].join("\n");
  });
  const classes = [...declared.values()];
  const typing = ["Any", "Literal", "NotRequired", "Protocol", "TypedDict", "overload"].filter(
    (name) => name !== "NotRequired" || classes.some((cls) => cls.includes("NotRequired[")),
  );
  const kinds = source.errorKinds.map((kind) => `    "${kind}",`).join("\n");
  const bridge = [
    "class Bridge(Protocol):",
    '    """The tier\'s channel to the host: a ctx call\'s value, or `CtxError` when the host refuses it."""',
    ...overloads.flatMap((overload) => ["", overload]),
    "",
    "    async def call(self, method: str, args: Mapping[str, object]) -> Any: ...",
  ].join("\n");
  return [
    `# ${GENERATED_BY}`,
    `"""The ctx surface's result types, refusal kinds and bridge, from Cogmo's contract."""`,
    "",
    "from collections.abc import Mapping",
    `from typing import ${typing.join(", ")}`,
    "",
    `type CtxErrorKind = Literal[\n${kinds}\n]`,
    ...[...classes, bridge].flatMap((block) => ["", "", block]),
    "",
  ].join("\n");
}

/** `cogmo_ctx/_contract.py` for Cogmo's ctx contract. */
export function renderPythonContract(): string {
  return renderPythonModule({
    results: R.mapValues(CTX_CONTRACT, ({ result }) => result),
    errorKinds: CtxErrorKindSchema.options,
  });
}

/**
 * The runtime's pydantic pins and the floors of its other requirements, for
 * the skills image's pytest to check against the pydantic it installs.
 */
export function renderRuntimePackages(): string {
  const document = { $comment: GENERATED_BY, pins: RUNTIME_PACKAGES, floors: RUNTIME_FLOORS };
  return `${JSON.stringify(document, null, 2)}\n`;
}
