import { err, ok, type Result } from "neverthrow";
import * as R from "remeda";
import { match } from "ts-pattern";
import type { Node } from "web-tree-sitter";
import {
  BUILTINS_MODULES,
  DYNAMIC_CODE_NAMES,
  DYNAMIC_IMPORT_NAMES,
  SKILL_BODY_MAX_CHARACTERS,
  SKILL_BODY_MAX_LINES,
} from "./ast-rules.js";
import { hostAllowed, parseHttpUrl } from "./http-destination.js";
import {
  callArgument,
  ctxRequest,
  fromImportStatementBindings,
  importStatementBindings,
  isStringLiteral,
  literalText,
  literalUrl,
  type NameBinding,
  parameterList,
  positionOf,
  readSkillTree,
  type SkillTree,
  scopeBindings,
} from "./python-ast.js";
import { withPythonTree } from "./python-parser.js";
import { skillDir } from "./skill-files.js";
import { SKILL_BODY_FILE } from "./skill-source.js";
import type { SkillManifest } from "./types.js";
import { lintWasmCompat } from "./worker-wasm/wasm-lint.js";

/**
 * The register-time gates (design/skills.md → Register-time gates): checks
 * Cogmo decides on the host from `skill.py` and the parsed frontmatter, and
 * nothing else — no database, clock, network or sandbox. The gates' constants
 * live in `ast-rules.ts`; a change to a gate bumps `AST_CLASSIFIER_VERSION`.
 */

type SkillGateId = "size" | "syntax" | "entrypoint" | "dynamic_code" | "effects";

/** A gate's or `wasm-lint`'s finding, terminal for the tip. */
export interface SkillFinding {
  id: SkillGateId | "wasm_lint";
  /** `skills/<name>/skill.py`. */
  path: string;
  /** 1-based; null for a finding about the file. */
  line: number | null;
  /** 1-based, in UTF-16 code units; null for the file, and for `wasm-lint`. */
  column: number | null;
  message: string;
}

/** `<id>: <path>:<line>:<column>: <message>`, the position as far as the finding has one. */
export function formatSkillFinding(finding: SkillFinding): string {
  const column = finding.column === null ? "" : `:${finding.column}`;
  const position = finding.line === null ? "" : `:${finding.line}${column}`;
  return `${finding.id}: ${finding.path}${position}: ${finding.message}`;
}

/** The skill the gates read: its name, parsed frontmatter and `skill.py`. */
interface GatedSkill {
  name: string;
  manifest: SkillManifest;
  body: string;
}

/**
 * The gates' first three stages, each refusing with every finding it made:
 * Size, on the text; Syntax, the parse; then Entrypoint, Dynamic code,
 * Effects and `wasm-lint`. Errs with the first stage's findings that has any;
 * once all pass, hands the tree they read to `read`, the classifier at
 * register, and returns what it returns. Throws when the grammar cannot load,
 * or a walk or `read` throws.
 */
export async function runSkillGates<T>(
  skill: GatedSkill,
  read: (tree: SkillTree) => T,
): Promise<Result<T, readonly SkillFinding[]>> {
  const path = `${skillDir(skill.name)}${SKILL_BODY_FILE}`;
  const size = sizeFindings(path, skill.body);
  if (size.length > 0) return err(size);
  return withPythonTree(skill.body, (root): Result<T, readonly SkillFinding[]> => {
    const syntax = syntaxFindings(path, root);
    if (root === null || syntax.length > 0) return err(syntax);
    const tree = readSkillTree(root);
    const findings = [
      ...byPosition(entrypointFindings(path, root)),
      ...byPosition(dynamicCodeFindings(path, root)),
      ...byPosition(effectsFindings(path, tree, skill.manifest)),
      ...wasmLintFindings(path, skill),
    ];
    return findings.length > 0 ? err(findings) : ok(read(tree));
  });
}

function findingAt(
  id: SkillGateId,
  path: string,
  node: Node | null,
  message: string,
): SkillFinding {
  const position = node === null ? null : positionOf(node);
  return { id, path, line: position?.line ?? null, column: position?.column ?? null, message };
}

/** A gate's findings in document order, a finding about the file first. */
function byPosition(findings: readonly SkillFinding[]): SkillFinding[] {
  return R.sortBy(
    [...findings],
    (f) => f.line ?? 0,
    (f) => f.column ?? 0,
  );
}

/**
 * `skill.py` over its line or character bound. A character is a UTF-16 code
 * unit, the string's `length`. Lines end at `\n`, so `\r\n` counts once and a
 * lone `\r` ends none; a last line without a newline counts.
 */
function sizeFindings(path: string, body: string): SkillFinding[] {
  const newlines = body.split("\n").length - 1;
  const lines = newlines + (body.length > 0 && !body.endsWith("\n") ? 1 : 0);
  return [
    ...(lines > SKILL_BODY_MAX_LINES
      ? [findingAt("size", path, null, `${lines} lines, over the limit of ${SKILL_BODY_MAX_LINES}`)]
      : []),
    ...(body.length > SKILL_BODY_MAX_CHARACTERS
      ? [
          findingAt(
            "size",
            path,
            null,
            `${body.length} characters, over the limit of ${SKILL_BODY_MAX_CHARACTERS}`,
          ),
        ]
      : []),
  ];
}

/** A null tree, or a tree holding an error, which the classifier could not read whole. */
function syntaxFindings(path: string, root: Node | null): SkillFinding[] {
  if (root === null) return [findingAt("syntax", path, null, "tree-sitter returned no tree")];
  const error = firstSyntaxError(root);
  return error === null
    ? []
    : [
        findingAt(
          "syntax",
          path,
          error,
          "tree-sitter cannot parse this: a syntax error, or syntax newer than the vendored Python grammar",
        ),
      ];
}

/**
 * The first `ERROR` or `MISSING` node, in document order. A missing token the
 * grammar hides (the newline a lone `\r` leaves out between statements) has
 * no node of its own, so the innermost node holding it stands in for it.
 */
function firstSyntaxError(root: Node): Node | null {
  if (!root.hasError) return null;
  let node = root;
  while (!node.isError && !node.isMissing) {
    const next = node.children.find((child) => child.hasError || child.isMissing);
    if (next === undefined) return node;
    node = next;
  }
  return node;
}

/**
 * Anything but one undecorated `async def run` directly under `module`, with
 * exactly two parameters, none `*args`, `**kwargs` or keyword-only, annotated
 * `Input` and `-> Output` by their bare names where the module defines those
 * classes.
 */
function entrypointFindings(path: string, root: Node): SkillFinding[] {
  const bindings = runBindings(root);
  if (bindings.length === 0) {
    return [
      findingAt(
        "entrypoint",
        path,
        null,
        "skill.py binds no `run`; define `async def run(inputs, ctx)` directly at module level",
      ),
    ];
  }
  const entry = bindings
    .filter((binding) => binding.kind === "definition")
    .map((binding) => binding.definition)
    .find(isEntrypoint);
  const misplaced = bindings
    .filter((binding) => binding.kind === "name" || binding.definition !== entry)
    .map((binding) =>
      findingAt(
        "entrypoint",
        path,
        binding.node,
        match(binding)
          .with({ kind: "name" }, () => "`run` is rebound here; its one binding is its `async def`")
          .with({ kind: "definition" }, ({ definition }) =>
            isEntrypoint(definition)
              ? "`run` is defined more than once; keep one `async def run`"
              : "`run` must be one undecorated `async def` directly at module level",
          )
          .exhaustive(),
      ),
    );
  return [...misplaced, ...(entry === undefined ? [] : signatureFindings(path, root, entry))];
}

function isEntrypoint(definition: Node): boolean {
  return (
    definition.type === "function_definition" &&
    definition.child(0)?.type === "async" &&
    definition.parent?.type === "module"
  );
}

function signatureFindings(path: string, root: Node, run: Node): SkillFinding[] {
  const parametersNode = run.childForFieldName("parameters");
  const parameters = parametersNode === null ? [] : parameterList(parametersNode);
  const atParameters = (message: string) =>
    findingAt("entrypoint", path, parametersNode ?? run, message);
  const kinds = new Set(parameters.map((p) => p.kind));
  const first = parameters[0];
  const returnType = run.childForFieldName("return_type");
  return [
    ...(kinds.has("var_positional") ? [atParameters("`run` takes no `*args`")] : []),
    ...(kinds.has("var_keyword") ? [atParameters("`run` takes no `**kwargs`")] : []),
    ...(kinds.has("keyword_only") ? [atParameters("`run` takes no keyword-only parameters")] : []),
    ...(parameters.length === 2
      ? []
      : [
          atParameters(
            `\`run\` takes exactly two parameters, \`inputs\` and \`ctx\`; this one takes ${parameters.length}`,
          ),
        ]),
    ...(moduleDefinesClass(root, "Input") &&
    first?.kind === "positional" &&
    !isBareName(first.annotation, "Input")
      ? [
          findingAt(
            "entrypoint",
            path,
            first.annotation ?? first.node,
            "`run`'s first parameter must be annotated `Input`, the bare name of the module's `Input` class",
          ),
        ]
      : []),
    ...(moduleDefinesClass(root, "Output") && !isBareName(returnType, "Output")
      ? [
          findingAt(
            "entrypoint",
            path,
            returnType ?? run,
            "`run` must be annotated `-> Output`, the bare name of the module's `Output` class",
          ),
        ]
      : []),
  ];
}

/** An annotation that is exactly the identifier `name`: not a string, an attribute or a union. */
function isBareName(annotation: Node | null, name: string): boolean {
  const only = annotation?.type === "type" ? annotation.namedChildren : [];
  return only.length === 1 && only[0]?.type === "identifier" && only[0].text === name;
}

/** Whether a `class <name>` statement, bare or decorated, is a direct child of `module`. */
function moduleDefinesClass(root: Node, name: string): boolean {
  return root.namedChildren.some((statement) => {
    const definition =
      statement.type === "decorated_definition"
        ? statement.childForFieldName("definition")
        : statement;
    return (
      definition?.type === "class_definition" && definition.childForFieldName("name")?.text === name
    );
  });
}

/**
 * Every binding of `run` outside every function and class body
 * (`scopeBindings` of the module, a `match` capture among them), and
 * `global run` in any function or class body.
 */
function runBindings(root: Node): NameBinding[] {
  const globals = root
    .descendantsOfType("global_statement")
    .filter(inDefinitionBody)
    .flatMap((statement) => statement.namedChildren)
    .map((node): NameBinding => ({ kind: "name", name: node.text, node }));
  return R.sortBy(
    [...scopeBindings(root), ...globals].filter((binding) => binding.name === "run"),
    (binding) => binding.node.startIndex,
  );
}

function inDefinitionBody(node: Node): boolean {
  let scope = node.parent;
  while (scope !== null) {
    if (scope.type === "function_definition" || scope.type === "class_definition") return true;
    scope = scope.parent;
  }
  return false;
}

/**
 * Code built at run time: `exec`, `eval`, `compile` or `__import__`, as an
 * identifier or as an attribute of `builtins` or `__builtins__`;
 * `import_module` or `__import__` on a name bound to `importlib`; a name
 * `from importlib import` or `from builtins import` binds to one of those, at
 * its import and each use; and `getattr` on a name an `import` binds with a
 * second argument that is not a string literal. There is no scope analysis,
 * so a skill's own `compile` counts too.
 */
function dynamicCodeFindings(path: string, root: Node): SkillFinding[] {
  const imported = root.descendantsOfType("import_statement").flatMap(importStatementBindings);
  const importBound = new Set(imported.map((b) => b.name));
  const importlib = new Set(imported.filter((b) => b.target === "importlib").map((b) => b.name));
  const fromImported = root
    .descendantsOfType("import_from_statement")
    .flatMap(fromImportStatementBindings);
  const bindsTo = (module: string, names: ReadonlySet<string>) =>
    fromImported.filter(
      (b) => b.target.startsWith(`${module}.`) && names.has(b.target.slice(module.length + 1)),
    );
  const runsCode = bindsTo("builtins", DYNAMIC_CODE_NAMES);
  const importsModule = bindsTo("importlib", DYNAMIC_IMPORT_NAMES);
  const runsCodeNames = new Set(runsCode.map((b) => b.name));
  const importsModuleNames = new Set(importsModule.map((b) => b.name));
  const at = (node: Node, message: string) => findingAt("dynamic_code", path, node, message);
  const runs = (node: Node, name: string) =>
    at(node, `\`${name}\` runs code built at run time; keep the code static`);
  const importsNamed = (node: Node, name: string) =>
    at(node, `\`${name}\` imports a module named at run time; import it statically`);

  const imports = [
    ...runsCode.map((b) => runs(b.node, b.name)),
    ...importsModule.map((b) => importsNamed(b.node, b.name)),
  ];
  const references = referenceIdentifiers(root).flatMap((id) => {
    if (DYNAMIC_CODE_NAMES.has(id.text) || runsCodeNames.has(id.text)) return [runs(id, id.text)];
    if (importsModuleNames.has(id.text)) return [importsNamed(id, id.text)];
    return [];
  });
  const attributes = root.descendantsOfType("attribute").flatMap((attribute) => {
    const object = attribute.childForFieldName("object");
    const name = attribute.childForFieldName("attribute");
    if (object?.type !== "identifier" || name === null) return [];
    const dotted = `${object.text}.${name.text}`;
    if (BUILTINS_MODULES.has(object.text) && DYNAMIC_CODE_NAMES.has(name.text)) {
      return [runs(attribute, dotted)];
    }
    if (importlib.has(object.text) && DYNAMIC_IMPORT_NAMES.has(name.text)) {
      return [importsNamed(attribute, dotted)];
    }
    return [];
  });
  const getattrs = root.descendantsOfType("call").flatMap((call) => {
    if (call.childForFieldName("function")?.text !== "getattr") return [];
    const module = callArgument(call, 0, null);
    const name = callArgument(call, 1, null);
    if (module?.type !== "identifier" || !importBound.has(module.text) || name === null) return [];
    return isStringLiteral(name)
      ? []
      : [
          at(
            call,
            `\`getattr\` reads the module \`${module.text}\` by a computed name; name the attribute`,
          ),
        ];
  });
  return [...imports, ...references, ...attributes, ...getattrs];
}

const IMPORT_STATEMENTS: ReadonlySet<string> = new Set([
  "import_statement",
  "import_from_statement",
  "future_import_statement",
]);

/** A node, and the ancestors a walk from the root passed through to reach it. */
interface Lineage {
  node: Node;
  parent: Lineage | null;
}

/**
 * Every identifier outside the import statements, whose names the
 * forbidden-target check above reads, that refers to a name. One walk from
 * the root carrying each node's ancestors: tree-sitter finds a node's
 * `parent` by walking down from the root, which costs the tree's depth per
 * identifier.
 */
function referenceIdentifiers(root: Node): Node[] {
  const references: Node[] = [];
  const stack: Lineage[] = [{ node: root, parent: null }];
  for (let at = stack.pop(); at !== undefined; at = stack.pop()) {
    if (at.node.type === "identifier" && isReference(at)) references.push(at.node);
    if (IMPORT_STATEMENTS.has(at.node.type)) continue;
    for (const child of at.node.namedChildren.toReversed()) stack.push({ node: child, parent: at });
  }
  return references;
}

/**
 * Whether an identifier refers to a name: not an attribute node's
 * `attribute`, a dotted name's part after the first, a keyword argument's
 * name, a keyword pattern's keyword, a parameter's name or a definition's
 * name.
 */
function isReference({ node: id, parent: up }: Lineage): boolean {
  if (up === null) return true;
  const parent = up.node;
  const isField = (field: string) => parent.childForFieldName(field)?.equals(id) === true;
  const isFirst = () => parent.namedChild(0)?.equals(id) === true;
  return match(parent.type)
    .with("attribute", () => !isField("attribute"))
    .with("dotted_name", isFirst)
    .with("keyword_pattern", () => !isFirst())
    .with(
      "keyword_argument",
      "default_parameter",
      "typed_default_parameter",
      () => !isField("name"),
    )
    .with("function_definition", "class_definition", () => !isField("name"))
    .with("parameters", "lambda_parameters", "typed_parameter", () => false)
    .with("list_splat_pattern", "dictionary_splat_pattern", () => {
      const holder = up.parent?.node.type;
      return (
        holder !== "parameters" && holder !== "lambda_parameters" && holder !== "typed_parameter"
      );
    })
    .otherwise(() => true);
}

/**
 * A `ctx.http` request whose literal URL does not parse, is not `http:` or
 * `https:`, or names a host `network.allow` does not admit; a
 * `ctx.secrets.get` whose literal name `secrets:` does not declare. Each is
 * refused as the handler would refuse the call at run time; a non-literal URL
 * or name is left to the run.
 */
function effectsFindings(path: string, tree: SkillTree, manifest: SkillManifest): SkillFinding[] {
  const allow = manifest.network?.allow ?? [];
  const secrets = new Set(manifest.secrets.map((s) => (typeof s === "string" ? s : s.name)));
  const at = (node: Node, message: string) => findingAt("effects", path, node, message);
  return tree.ctxCalls.flatMap((call): SkillFinding[] => {
    if (call.namespace === "secrets" && call.method === "get") {
      const nameNode = callArgument(call.call, 0, "name");
      const name = literalText(nameNode);
      return nameNode === null || name === null || secrets.has(name)
        ? []
        : [at(nameNode, `secret '${name}' is not declared in SKILL.md frontmatter`)];
    }
    const urlNode = ctxRequest(call)?.url ?? null;
    const url = literalUrl(urlNode);
    if (urlNode === null || url === null) return [];
    return parseHttpUrl(url.head).match(
      (destination) =>
        hostAllowed(destination.hostname, allow)
          ? []
          : [
              at(
                urlNode,
                allow.length === 0
                  ? "this skill declares no 'network:' block, so ctx.http reaches no host"
                  : `'${destination.hostname}' is not in this skill's network.allow list`,
              ),
            ],
      (refusal) => [
        at(
          urlNode,
          match(refusal)
            .with({ kind: "unparseable" }, () => `ctx.http could not parse url: ${url.head}`)
            .with(
              { kind: "not_http" },
              ({ protocol }) => `ctx.http supports http and https, got '${protocol}'`,
            )
            .exhaustive(),
        ),
      ],
    );
  });
}

/** `wasm-lint`'s findings, for the wasm tier: a line, no column. */
function wasmLintFindings(path: string, skill: GatedSkill): SkillFinding[] {
  if (skill.manifest.tier !== "wasm") return [];
  return lintWasmCompat(skill.body).match(
    () => [],
    (errors) =>
      errors.map(
        (error): SkillFinding => ({
          id: "wasm_lint",
          path,
          line: error.line,
          column: null,
          message: error.reason,
        }),
      ),
  );
}
