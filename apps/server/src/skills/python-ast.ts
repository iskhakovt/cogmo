import * as R from "remeda";
import { match } from "ts-pattern";
import type { Node } from "web-tree-sitter";

/**
 * Readers of tree-sitter Python nodes that the register-time gates
 * (`skill-gates.ts`) and the classifier (`ast-classifier.ts`) share, so both
 * read a `ctx` call, an argument and a literal the same way
 * (design/skills.md → Register-time gates → Terms).
 */

/** A 1-based line, and a 1-based column in UTF-16 code units, as web-tree-sitter counts them. */
export interface SourcePosition {
  line: number;
  column: number;
}

export function positionOf(node: Node): SourcePosition {
  return { line: node.startPosition.row + 1, column: node.startPosition.column + 1 };
}

export type ParameterKind = "positional" | "var_positional" | "keyword_only" | "var_keyword";

/** One parameter of a `parameters` or `lambda_parameters` node. A `/` or `*` separator is not one. */
export interface Parameter {
  node: Node;
  /** Null for a Python 2 tuple parameter. */
  name: string | null;
  kind: ParameterKind;
  annotation: Node | null;
}

export function parameterList(parameters: Node): Parameter[] {
  const nodes = parameters.namedChildren.filter((node) => node.type !== "comment");
  // Every parameter after a `*` or a `*args` is keyword-only.
  const star = nodes.findIndex((node) =>
    ["keyword_separator", "list_splat_pattern"].includes(unwrapParameter(node).type),
  );
  return nodes.flatMap((node, i): Parameter[] => {
    const inner = unwrapParameter(node);
    const annotation =
      node.type === "typed_parameter" || node.type === "typed_default_parameter"
        ? node.childForFieldName("type")
        : null;
    if (inner.type === "keyword_separator" || inner.type === "positional_separator") return [];
    if (inner.type === "list_splat_pattern" || inner.type === "dictionary_splat_pattern") {
      const kind = inner.type === "list_splat_pattern" ? "var_positional" : "var_keyword";
      return [{ node, name: splatName(inner), kind, annotation }];
    }
    const name = inner.type === "identifier" ? inner : inner.childForFieldName("name");
    return [
      {
        node,
        name: name?.type === "identifier" ? name.text : null,
        kind: star !== -1 && i > star ? "keyword_only" : "positional",
        annotation,
      },
    ];
  });
}

/** A `typed_parameter` wraps its name, or its `*args` or `**kwargs`, unlabelled. */
function unwrapParameter(node: Node): Node {
  return node.type === "typed_parameter"
    ? (node.namedChildren.find((child) => child.type !== "type") ?? node)
    : node;
}

function splatName(splat: Node): string | null {
  return splat.namedChildren.find((child) => child.type === "identifier")?.text ?? null;
}

/** A function or class definition's statement: its `decorated_definition` when decorated. */
function definitionStatement(definition: Node): Node {
  const parent = definition.parent;
  return parent?.type === "decorated_definition" ? parent : definition;
}

/** Whether a definition sits directly in a class body, bare or decorated. */
function inClassBody(definition: Node): boolean {
  const block = definitionStatement(definition).parent;
  return block?.type === "block" && block.parent?.type === "class_definition";
}

/** A call `<receiver>.<namespace>.<method>(…)` on a ctx receiver. */
export interface CtxCall {
  call: Node;
  namespace: string;
  method: string;
}

/**
 * Every ctx call under `root`. The receiver is an `identifier` whose nearest
 * binding, walking out through the functions, lambdas and comprehensions
 * enclosing the call, is a parameter, other than the first parameter of a
 * function defined directly in a class body; a parameter its function
 * reassigns stays a receiver. A nearer binding of any other kind makes the
 * name no receiver.
 */
export function ctxCalls(root: Node): CtxCall[] {
  return root.descendantsOfType("call").flatMap((call): CtxCall[] => {
    const fn = call.childForFieldName("function");
    const inner = fn?.type === "attribute" ? fn.childForFieldName("object") : null;
    const method = fn?.childForFieldName("attribute");
    if (inner?.type !== "attribute" || method === null || method === undefined) return [];
    const receiver = inner.childForFieldName("object");
    const namespace = inner.childForFieldName("attribute");
    if (receiver?.type !== "identifier" || namespace === null) return [];
    return isCtxReceiver(receiver)
      ? [{ call, namespace: namespace.text, method: method.text }]
      : [];
  });
}

/** How a scope resolves a name: to a ctx receiver, to another binding, or not at all. */
type Resolution = "receiver" | "shadowed" | "unbound";

function isCtxReceiver(receiver: Node): boolean {
  const resolve = (scope: Node | null, child: Node): boolean =>
    scope !== null &&
    match(resolveIn(scope, child, receiver))
      .with("receiver", () => true)
      .with("shadowed", () => false)
      .with("unbound", () => resolve(scope.parent, scope))
      .exhaustive();
  return resolve(receiver.parent, receiver);
}

const COMPREHENSIONS: ReadonlySet<string> = new Set([
  "list_comprehension",
  "set_comprehension",
  "dictionary_comprehension",
  "generator_expression",
]);

/** How `scope`, reached from its child `child`, resolves the receiver's name. */
function resolveIn(scope: Node, child: Node, receiver: Node): Resolution {
  const name = receiver.text;
  if (scope.type === "function_definition" || scope.type === "lambda") {
    // Defaults, decorators and annotations run in the enclosing scope.
    const body = scope.childForFieldName("body");
    if (body === null || !body.equals(child)) return "unbound";
    const parameters = scope.childForFieldName("parameters");
    const names = parameters === null ? [] : parameterList(parameters).map((p) => p.name);
    const position = names.indexOf(name);
    if (position !== -1) {
      const methodSelf =
        position === 0 && scope.type === "function_definition" && inClassBody(scope);
      return methodSelf ? "shadowed" : "receiver";
    }
    const declares = (type: string) =>
      scopeNodes(body).some(
        (node) => node.type === type && node.namedChildren.some((id) => id.text === name),
      );
    if (declares("nonlocal_statement")) return "unbound";
    const bound = declares("global_statement") || scopeBindings(body).some((b) => b.name === name);
    return bound ? "shadowed" : "unbound";
  }
  if (COMPREHENSIONS.has(scope.type)) {
    const clauses = scope.namedChildren.filter((node) => node.type === "for_in_clause");
    // The outermost iterable runs in the enclosing scope.
    const outermost = clauses[0]?.childForFieldName("right");
    if (outermost && contains(outermost, receiver)) return "unbound";
    const targets = clauses.flatMap((clause) => targetNames(clause.childForFieldName("left")));
    return targets.some((target) => target.text === name) ? "shadowed" : "unbound";
  }
  return "unbound";
}

function contains(outer: Node, inner: Node): boolean {
  return outer.startIndex <= inner.startIndex && inner.endIndex <= outer.endIndex;
}

/** A name a scope binds; `node` is a definition's statement, or the bound name. */
export type NameBinding =
  | { kind: "definition"; name: string; node: Node; definition: Node }
  | { kind: "name"; name: string; node: Node };

/**
 * Every name `scope` binds in its own scope — the module, a function's body
 * or a lambda's: a definition's name; an assignment target, plain, annotated,
 * augmented or unpacked; a `for`, `with` or `except … as` target; a named
 * expression; an `import` or `from … import` name; and a `match` capture.
 */
export function scopeBindings(scope: Node): NameBinding[] {
  const named = (nodes: readonly Node[]) =>
    nodes.map((node): NameBinding => ({ kind: "name", name: node.text, node }));
  return scopeNodes(scope).flatMap((node): NameBinding[] =>
    match(node.type)
      .with("function_definition", "class_definition", (): NameBinding[] => {
        const name = node.childForFieldName("name");
        return name === null
          ? []
          : [
              {
                kind: "definition",
                name: name.text,
                node: definitionStatement(node),
                definition: node,
              },
            ];
      })
      .with("assignment", "augmented_assignment", "for_statement", () =>
        named(targetNames(node.childForFieldName("left"))),
      )
      // `with` and `except`; a case pattern's `as` is a capture, read below.
      .with("as_pattern", () => named(targetNames(node.childForFieldName("alias"))))
      .with("named_expression", () => named(targetNames(node.childForFieldName("name"))))
      .with("import_statement", () => named(importStatementBindings(node).map((b) => b.node)))
      .with("import_from_statement", () =>
        named(fromImportStatementBindings(node).map((b) => b.node)),
      )
      .with("case_clause", () =>
        named(
          node.namedChildren
            .filter((child) => child.type === "case_pattern")
            .flatMap(patternCaptures),
        ),
      )
      .otherwise(() => []),
  );
}

/**
 * Every node of `scope`'s own scope, in document order. A nested function's
 * or class's body, and a lambda's, belong to scopes of their own; its
 * defaults, decorators and bases run here. A comprehension's targets are its
 * own, but a named expression inside it binds here, so it is read through.
 */
function scopeNodes(scope: Node): Node[] {
  const visit = (node: Node): Node[] =>
    match(node.type)
      .with("function_definition", "class_definition", () => {
        const body = node.childForFieldName("body");
        return [
          node,
          ...node.namedChildren
            .filter((child) => body === null || !child.equals(body))
            .flatMap(visit),
        ];
      })
      .with("lambda", () => {
        const parameters = node.childForFieldName("parameters");
        return [node, ...(parameters === null ? [] : visit(parameters))];
      })
      .otherwise(() => [node, ...node.namedChildren.flatMap(visit)]);
  return scope.namedChildren.flatMap(visit);
}

/** The names an assignment target binds; an attribute or subscript binds none. */
function targetNames(target: Node | null): Node[] {
  if (target === null) return [];
  if (target.type === "identifier") return [target];
  return match(target.type)
    .with(
      "pattern_list",
      "tuple_pattern",
      "list_pattern",
      "tuple",
      "list",
      "parenthesized_expression",
      "list_splat_pattern",
      "list_splat",
      "as_pattern_target",
      () => target.namedChildren.flatMap(targetNames),
    )
    .otherwise(() => []);
}

/**
 * The names a `match` pattern captures: a bare name (a dotted one is a value
 * pattern), a `*` or `**` rest, and an `as` name, at any depth. A class
 * pattern's class, a keyword pattern's keyword, a mapping key and `_` bind
 * nothing.
 */
function patternCaptures(pattern: Node): Node[] {
  return match(pattern.type)
    .with("dotted_name", () => {
      const only = pattern.namedChildren;
      const name = only.length === 1 ? only[0] : undefined;
      return name !== undefined && name.text !== "_" ? [name] : [];
    })
    .with("splat_pattern", () =>
      pattern.namedChildren.filter((child) => child.type === "identifier" && child.text !== "_"),
    )
    .with("as_pattern", () =>
      pattern.namedChildren.flatMap((child) =>
        child.type === "identifier" ? [child] : patternCaptures(child),
      ),
    )
    .with("class_pattern", () =>
      pattern.namedChildren
        .filter((child) => child.type !== "dotted_name")
        .flatMap(patternCaptures),
    )
    .with("keyword_pattern", () => pattern.namedChildren.slice(1).flatMap(patternCaptures))
    .with("dict_pattern", () => {
      const keys = pattern.childrenForFieldName("key");
      return pattern.namedChildren
        .filter((child) => !keys.some((key) => key.equals(child)))
        .flatMap(patternCaptures);
    })
    .otherwise(() => pattern.namedChildren.flatMap(patternCaptures));
}

/** The `ctx.http` methods `cogmo_ctx` has, and the position of each one's URL argument. */
const CTX_HTTP_URL_POSITION = { get: 0, post: 0, request: 1 } as const;

type CtxHttpMethod = keyof typeof CTX_HTTP_URL_POSITION;

function isCtxHttpMethod(method: string): method is CtxHttpMethod {
  return Object.hasOwn(CTX_HTTP_URL_POSITION, method);
}

/** A `ctx.http` request: a call of `get`, `post` or `request`, with its URL argument. */
export interface CtxRequest {
  call: Node;
  method: CtxHttpMethod;
  url: Node | null;
}

export function ctxRequest(ctxCall: CtxCall): CtxRequest | null {
  const { method } = ctxCall;
  if (ctxCall.namespace !== "http" || !isCtxHttpMethod(method)) return null;
  const url = callArgument(ctxCall.call, CTX_HTTP_URL_POSITION[method], "url");
  return { call: ctxCall.call, method, url };
}

/**
 * The call's argument at `position`, or passed as `keyword`. Null when it is
 * absent, or when a `*` unpacking precedes the position, which leaves it
 * unknown.
 */
export function callArgument(call: Node, position: number, keyword: string | null): Node | null {
  const args = call.childForFieldName("arguments");
  if (args?.type !== "argument_list") return null;
  const items = args.namedChildren.filter((item) => item.type !== "comment");
  const positional = R.takeWhile(
    items.filter((item) => item.type !== "keyword_argument" && item.type !== "dictionary_splat"),
    (item) => item.type !== "list_splat",
  );
  const named = items.find(
    (item) =>
      keyword !== null &&
      item.type === "keyword_argument" &&
      item.childForFieldName("name")?.text === keyword,
  );
  return positional[position] ?? named?.childForFieldName("value") ?? null;
}

/** A string literal: a `string` node with no interpolation. */
export function isStringLiteral(node: Node): boolean {
  return (
    node.type === "string" && !node.namedChildren.some((part) => part.type === "interpolation")
  );
}

/** Whether a `string_content` holds an escape, whose text is not its value. */
function holdsEscape(content: Node): boolean {
  return content.namedChildren.some(
    (part) => part.type === "escape_sequence" || part.type === "escape_interpolation",
  );
}

/**
 * The text of a string literal holding no escape, for a URL, a secret name or
 * a method: the gates do not decode escapes, so one holding an escape
 * sequence (or an f-string's `{{` and `}}`) is non-literal. Null for anything
 * else.
 */
export function literalText(node: Node | null): string | null {
  if (node === null || !isStringLiteral(node)) return null;
  const contents = node.namedChildren.filter((part) => part.type === "string_content");
  return contents.some(holdsEscape) ? null : contents.map((part) => part.text).join("");
}

/** A URL argument whose host the source fixes. */
export interface LiteralUrl {
  /** The text WHATWG parses: the whole literal, or an f-string's text before its first replacement field. */
  head: string;
  /**
   * Whether a replacement field falls in the path, before any `?` or `#`,
   * read from the template before URL normalization, which a field's `..`
   * could otherwise defeat. A field-free path is the head's.
   */
  templatedPath: boolean;
}

/** Text holding a complete authority: a scheme, `//`, a non-empty authority, then `/`, `?` or `#`. */
const HOLDS_AUTHORITY = /^[A-Za-z][A-Za-z0-9+.-]*:\/\/[^/?#]+[/?#]/;

/**
 * A URL argument that is a string literal, or an f-string whose text before
 * its first replacement field holds a complete authority that WHATWG parses:
 * non-empty, and ended by `/`, `?` or `#`. Null for any other argument, or
 * one holding an escape. An empty or unparseable authority leaves the host to
 * the field: WHATWG skips the empty one in `https:///`, so the field supplies
 * it.
 */
export function literalUrl(node: Node | null): LiteralUrl | null {
  if (node?.type !== "string") return null;
  const pieces = node.namedChildren.filter(
    (part) => part.type === "string_content" || part.type === "interpolation",
  );
  if (pieces.some((part) => part.type === "string_content" && holdsEscape(part))) return null;
  const field = pieces.findIndex((part) => part.type === "interpolation");
  const head = pieces
    .slice(0, field === -1 ? pieces.length : field)
    .map((part) => part.text)
    .join("");
  if (field === -1) return { head, templatedPath: false };
  const authority = HOLDS_AUTHORITY.exec(head);
  if (authority === null || URL.parse(head) === null) return null;
  // The path runs from the authority's end to the first `?` or `#`, and the
  // first field directly follows the head.
  return { head, templatedPath: !/[?#]/.test(head.slice(authority[0].length - 1)) };
}

/** A name an `import` or `from … import` statement binds. */
export interface ImportBinding {
  /** The bound name, as it appears in the statement. */
  node: Node;
  name: string;
  /** The dotted module the name is bound to: for `from m import x`, `m.x`. */
  target: string;
}

/**
 * The names an `import` statement binds: `import a.b` binds `a` to `a`, and
 * `import a.b as c` binds `c` to `a.b`.
 */
export function importStatementBindings(statement: Node): ImportBinding[] {
  return statement.childrenForFieldName("name").flatMap((name): ImportBinding[] => {
    if (name.type === "aliased_import") {
      const alias = name.childForFieldName("alias");
      const dotted = name.childForFieldName("name");
      return alias === null || dotted === null
        ? []
        : [{ node: alias, name: alias.text, target: dotted.text }];
    }
    const first = name.type === "dotted_name" ? name.namedChild(0) : null;
    return first?.type === "identifier"
      ? [{ node: first, name: first.text, target: first.text }]
      : [];
  });
}

/** The names `from m import x` and `from m import x as y` bind, for an absolute `m`. */
export function fromImportStatementBindings(statement: Node): ImportBinding[] {
  const module = statement.childForFieldName("module_name");
  if (module?.type !== "dotted_name") return [];
  return statement.childrenForFieldName("name").flatMap((name): ImportBinding[] => {
    const imported = name.type === "aliased_import" ? name.childForFieldName("name") : name;
    const bound = name.type === "aliased_import" ? name.childForFieldName("alias") : name;
    return imported === null || bound === null
      ? []
      : [{ node: bound, name: bound.text, target: `${module.text}.${imported.text}` }];
  });
}
