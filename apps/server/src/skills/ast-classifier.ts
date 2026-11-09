/**
 * AST-based risk classifier for skill bodies. Walks the Python source
 * via tree-sitter and detects undeclared effects (process spawn,
 * filesystem mutation, external messaging, financial APIs, and the
 * `ctx` calls that need an effect) that the manifest didn't list.
 * Detection promotes the deploy's risk tier and, for
 * "dangerous-when-undeclared" categories, *rejects* the deploy with
 * `validation_errors` describing the manifest-vs-code mismatch.
 *
 * **THIS IS NOT A SECURITY BOUNDARY.** A skill can `getattr(
 * __import__("os"), "system")(...)`, alias a module under a different
 * name, or use a third-party SDK we don't have a rule for, and bypass
 * detection. The actual security boundaries are sysbox isolation
 * (container), the `effects`-driven secret allowlist (P3.4), and the
 * `approve` tier for risky skills. AST lint serves two narrower
 * purposes:
 *
 *   1. **UX gate** — force the manifest's `effects:` to track what
 *      the body actually does, so a skill author can't ship something
 *      that `smtplib.SMTP(...)`-s without saying so.
 *
 *   2. **Tier promoter** — when nothing dangerous is detected AND
 *      nothing dangerous is declared, the table reaches `auto` (no
 *      human tap, ships immediately), capped at `notify` until the wasm tier
 *      is hardened and a review panel is set ({@link computeRiskTier}).
 *
 * Rules live in `ast-rules.ts` as pure data: a rule of an existing shape
 * is one row, and a new shape is a change to the walker in this file, which
 * runs on the parser `python-parser.ts` shares with the register-time gates.
 *
 * Failure mode: a throw here (parser load, walk, unexpected node shape)
 * propagates. Register rejects on it as the pausing `registrar_unavailable`
 * (`parser`) and deploys no body this path did not read; rollback's
 * `classifyManifest` falls back to the declaration-only stub
 * (design/skills.md → Classifier → Failure mode).
 */

import * as R from "remeda";
import { match } from "ts-pattern";
import type { Node, TreeCursor } from "web-tree-sitter";
import {
  APPROVE_GATING_EFFECTS,
  APPROVE_SECRETS_THRESHOLD,
  admitsWriteEndpoint,
  CALL_RULES,
  categoriseDependency,
  IMPORT_RULES,
  isWriteRequest,
  REJECT_ON_UNDECLARED,
  type RequestPath,
  WRITE_EFFECTS,
} from "./ast-rules.js";
import type { SkillsCapabilities } from "./capabilities.js";
import { parseHttpUrl } from "./http-destination.js";
import {
  type CtxRequest,
  callArgument,
  ctxRequest,
  literalText,
  literalUrl,
  readSkillTree,
  type SkillTree,
} from "./python-ast.js";
import { withPythonTree } from "./python-parser.js";
import type { SkillRiskReason } from "./risk-reasons.js";
import type { ClassifierLog, SkillEffect, SkillManifest } from "./types.js";

export const AST_CLASSIFIER_VERSION = "ast-3";

interface DetectedHit {
  effect: SkillEffect;
  label: string;
  /** Whether a ctx row detected it: rollback does not reject on those alone. */
  ctx: boolean;
}

/**
 * Walk a tree-sitter Python tree and return one `DetectedHit` per
 * matched import or call. Multiple hits per effect are deduped at the
 * caller; we keep them all here so the call sites can surface
 * specific labels in `validation_errors` ("undeclared effect:
 * sends_email — saw `smtplib`").
 */
function detectHits(tree: SkillTree, manifest: SkillManifest): DetectedHit[] {
  return [...moduleHits(tree.root), ...ctxHits(tree, manifest)];
}

/** The import and call rows' hits, on any receiver but a ctx one. */
function moduleHits(rootNode: Node): DetectedHit[] {
  const hits: DetectedHit[] = [];

  // Walk via cursor — far cheaper than `namedChild(i)` on large trees — in
  // a loop, so no depth of tree overflows the call stack. The cursor wraps a
  // WASM heap allocation that the JS GC can't see; release it in a `finally`
  // so a thrown rule (or a future panic in a child) can't leak.
  const cursor = rootNode.walk();
  try {
    do {
      visitNode(cursor.currentNode, hits);
    } while (advancePreOrder(cursor));
  } finally {
    cursor.delete();
  }
  return hits;
}

/** Move the cursor to the next node in document order; false once the walk is done. */
function advancePreOrder(cursor: TreeCursor): boolean {
  if (cursor.gotoFirstChild()) return true;
  do {
    if (cursor.gotoNextSibling()) return true;
  } while (cursor.gotoParent());
  return false;
}

function visitNode(node: Node, hits: DetectedHit[]): void {
  switch (node.type) {
    case "import_statement":
      for (const name of extractImportModules(node)) {
        for (const rule of IMPORT_RULES) {
          if (rule.module === name) {
            hits.push({ effect: rule.effect, label: rule.label, ctx: false });
          }
        }
      }
      break;
    case "import_from_statement": {
      const module = extractImportFromModule(node);
      if (module) {
        for (const rule of IMPORT_RULES) {
          if (rule.module === module) {
            hits.push({ effect: rule.effect, label: rule.label, ctx: false });
          }
        }
      }
      break;
    }
    case "call":
      matchCall(node, hits);
      break;
  }
}

/**
 * `import a, b.c, d` → ["a", "b", "d"]. We collapse dotted names to
 * the leftmost identifier because that's the package root, which is
 * what our import-rules table keys on (we don't want to match
 * `email.message` separately from `email.mime.text`).
 */
function extractImportModules(node: Node): string[] {
  return node.namedChildren.flatMap((child) => {
    if (child.type !== "dotted_name" && child.type !== "aliased_import") return [];
    const dotted = child.type === "dotted_name" ? child : child.namedChild(0);
    if (dotted?.type !== "dotted_name") return [];
    const first = dotted.namedChild(0);
    return first?.type === "identifier" ? [first.text] : [];
  });
}

/** `from a.b.c import x` → "a"; `from . import x` → null (relative). */
function extractImportFromModule(node: Node): string | null {
  // `module_name` field is the dotted source. tree-sitter-python uses
  // a positional layout — first named child is the module path
  // (could be a `dotted_name` or a `relative_import`). We only care
  // about absolute imports; relative imports inside a skill don't map
  // to standalone packages.
  const firstChild = node.namedChild(0);
  if (firstChild?.type !== "dotted_name") return null;
  const root = firstChild.namedChild(0);
  if (root?.type !== "identifier") return null;
  return root.text;
}

/**
 * Match a `call` node against the rules table. Two shapes:
 *
 *   - `obj.attr(...)` — function part is `attribute` with a sub-
 *     `identifier` object and `identifier` attribute. Matches when
 *     a rule's `(object, attr)` pair matches.
 *   - `name(...)` — function part is a bare `identifier`. Matches
 *     rules with `object: null`.
 *
 * Method-on-arbitrary-receiver patterns (`p.write_text(...)`) are the
 * `object: null` flavour of an attribute call: receiver isn't an
 * identifier we track, but the attribute name itself is rule-worthy.
 * For those we look at the attribute name regardless of the receiver
 * shape (covered as "object: null + attr" via the second branch
 * below).
 */
function matchCall(node: Node, hits: DetectedHit[]): void {
  const fn = node.namedChild(0);
  if (!fn) return;

  // Bare `name(...)` — `open(...)`, `__import__(...)`.
  if (fn.type === "identifier") {
    const name = fn.text;
    for (const rule of CALL_RULES) {
      if (!("namespace" in rule) && rule.object === null && rule.attr === name) {
        if (rule.argPredicate === undefined || matchesArgPredicate(node, rule.argPredicate)) {
          hits.push({ effect: rule.effect, label: rule.label, ctx: false });
        }
      }
    }
    return;
  }

  // `obj.attr(...)` or `expr.attr(...)`.
  if (fn.type === "attribute") {
    // tree-sitter-python's `attribute` node has `object` (left) and
    // `attribute` (right) children. The left can be any expression;
    // we narrow to the bare-identifier case so that `subprocess.run`
    // matches but `mod.subprocess.run` doesn't (different semantics).
    const objectNode = fn.childForFieldName("object");
    const attrNode = fn.childForFieldName("attribute");
    if (!attrNode) return;
    const attrName = attrNode.text;
    const objectName = objectNode?.type === "identifier" ? objectNode.text : null;

    for (const rule of CALL_RULES) {
      if ("namespace" in rule || rule.attr !== attrName) continue;
      // Two match modes against `rule.object`:
      //   - rule.object === objectName (with both non-null) — qualified call
      //   - rule.object === null — attribute call where receiver is anything;
      //     used for `.write_text` / `.write_bytes` on Path-like values
      const objectMatches =
        rule.object === null || (objectName !== null && rule.object === objectName);
      if (!objectMatches) continue;
      if (rule.argPredicate === undefined || matchesArgPredicate(node, rule.argPredicate)) {
        hits.push({ effect: rule.effect, label: rule.label, ctx: false });
      }
    }
  }
}

/**
 * The ctx rows' hits: each `CALL_RULES` row with a `namespace` its call
 * matches, and each `ctx.http` write request as `writes_user_data` in a
 * skill declaring no write effect (design/skills.md → Register-time gates →
 * ctx rows).
 */
function ctxHits(tree: SkillTree, manifest: SkillManifest): DetectedHit[] {
  const calls = tree.ctxCalls;
  const ruleHits = calls.flatMap((call) =>
    CALL_RULES.filter((rule) => "namespace" in rule)
      .filter((rule) => rule.namespace === call.namespace && rule.attr === call.method)
      .map((rule): DetectedHit => ({ effect: rule.effect, label: rule.label, ctx: true })),
  );
  if (manifest.effects.some((effect) => WRITE_EFFECTS.has(effect))) return ruleHits;
  const allow = manifest.network?.allow ?? [];
  const writeHits = calls
    .map(ctxRequest)
    .filter(R.isNonNullish)
    .filter((request) => isWriteCall(request, allow))
    .map(
      (request): DetectedHit => ({
        effect: "writes_user_data",
        label: `ctx.http.${request.method}`,
        ctx: true,
      }),
    );
  return [...ruleHits, ...writeHits];
}

/**
 * Whether a `ctx.http` request is a write. Its method is the call's: `get`
 * and `post`, or `request`'s first argument or `method=`, uppercased as
 * `cogmo_ctx` sends it, a non-literal one a write. A `GET` whose URL is not
 * literal is a write when `network.allow` admits a `WRITE_ENDPOINTS` host;
 * one whose literal URL is not an http(s) URL sends nothing.
 */
function isWriteCall(request: CtxRequest, allow: ReadonlyArray<string>): boolean {
  const method = match(request.method)
    .with("get", () => "GET")
    .with("post", () => "POST")
    .with(
      "request",
      () => literalText(callArgument(request.call, 0, "method"))?.toUpperCase() ?? null,
    )
    .exhaustive();
  if (method === null) return true;
  const url = literalUrl(request.url);
  if (url === null) return method !== "GET" || admitsWriteEndpoint(allow);
  const head = parseHttpUrl(url.head);
  if (head.isErr()) return method !== "GET";
  const path: RequestPath = url.templatedPath
    ? { kind: "templated" }
    : { kind: "literal", path: head.value.pathname };
  return isWriteRequest(method, head.value.hostname, path);
}

/**
 * Predicate runners. Today we only need `open_write_mode`: match if
 * `args[1]` is a string literal whose Python-string value contains
 * a write-mode flag. Default mode is `"r"` (read) when omitted.
 *
 * Known gap: `open(file=path, mode="w")` (kwargs form) doesn't match
 * because we only inspect the second positional arg. Acceptable per
 * the head-comment threat model — operators wanting to slip a write
 * past the lint can already do so with `getattr(__import__("os"),
 * "system")`. Sysbox carries the security weight; AST lint is a UX
 * gate. If false negatives become a real problem, walk
 * `keyword_argument` children too.
 */
function matchesArgPredicate(callNode: Node, predicate: "open_write_mode"): boolean {
  if (predicate === "open_write_mode") {
    const args = callNode.childForFieldName("arguments");
    if (!args) return false;
    const second = args.namedChild(1);
    if (!second) return false;
    if (second.type !== "string") return false;
    const literal = stringLiteralValue(second);
    // Any of `w`, `a`, `x`, or `+` in the mode string means a write/
    // create/append/read-write open. `b` and `t` are width modifiers
    // and don't imply a write on their own.
    return /[wax+]/.test(literal);
  }
  return false;
}

/**
 * Extract the *content* of a Python string literal node. tree-sitter
 * exposes `string` as a wrapper containing `string_start`, one or
 * more `string_content` parts, and `string_end`. We concatenate the
 * `string_content` text, which is the literal value modulo escape
 * processing — sufficient for "does this contain `w`?" purposes.
 */
function stringLiteralValue(node: Node): string {
  return node.namedChildren
    .filter((child) => child.type === "string_content")
    .map((child) => child.text)
    .join("");
}

/**
 * The table reasons and the tier each one raises (design/skills.md → Risk
 * tiering & auto-apply → Tiers; Risk tiers without a human → Reasons).
 */
const TABLE_REASON_TIERS = {
  sensitive_dependency: "approve",
  approve_gating_effect: "approve",
  container_tier: "approve",
  secrets_with_network: "approve",
  secret_breadth: "approve",
  unlisted_dependency: "notify",
  declared_effect: "notify",
  network_declared: "notify",
} as const satisfies Partial<Record<SkillRiskReason, "notify" | "approve">>;

type TableReason = keyof typeof TABLE_REASON_TIERS;

type RiskTier = ClassifierLog["risk_tier"];

const TIER_SEVERITY: Readonly<Record<RiskTier, number>> = { auto: 0, notify: 1, approve: 2 };

export interface RiskTierInput {
  declared: ReadonlyArray<SkillEffect>;
  detected: ReadonlyArray<SkillEffect>;
  validationErrors: ReadonlyArray<string>;
  tier: SkillManifest["tier"];
  secretsCount: number;
  /** Whether the manifest declares a `network:` allowlist at all. */
  hasNetwork: boolean;
  dependencies: ReadonlyArray<string>;
  capabilities: SkillsCapabilities;
}

export interface RiskTierResult {
  riskTier: RiskTier;
  /** Every reason that applies, in a fixed order, not only the deciding one. */
  reasons: SkillRiskReason[];
}

/** The reasons whose predicate holds, in the order given. */
function raised<Reason extends SkillRiskReason>(
  triggers: ReadonlyArray<readonly [Reason, boolean]>,
): Reason[] {
  return triggers.filter(([, holds]) => holds).map(([reason]) => reason);
}

/**
 * Compute the `risk_tier` for a deploy, with every reason that applies.
 *
 * Each table predicate is evaluated; the tier is the most severe tier any
 * raised reason carries (approve > notify > auto), `auto` when none is
 * raised. Validation errors (an undeclared dangerous effect) reject the
 * deploy upstream; the tier is stamped `approve` so a recorded rejection
 * never carries `auto`.
 *
 * `auto` is capped at `notify` while the wasm tier is unhardened
 * (`wasm_unhardened`) and while no review panel stands in for the owner's
 * tap (`no_review_panel`); both are recorded when both flags are off.
 */
export function computeRiskTier(input: RiskTierInput): RiskTierResult {
  const effects = [...input.declared, ...input.detected];
  const depCategories = new Set(input.dependencies.map(categoriseDependency));
  // A credential the body can read plus a route off the machine is the
  // exfiltration pair, and no count of secrets makes it safe — the threshold
  // answers how broad a skill's permissions are, which is a different
  // question from whether it can send one somewhere. Egress on its own
  // reaches only what the allowlist named and carries no credential, so it
  // earns a note rather than a gate.
  const reasons = raised<TableReason>([
    ["sensitive_dependency", depCategories.has("approve")],
    ["approve_gating_effect", effects.some((e) => APPROVE_GATING_EFFECTS.has(e))],
    ["container_tier", input.tier === "container"],
    ["secrets_with_network", input.hasNetwork && input.secretsCount > 0],
    ["secret_breadth", input.secretsCount >= APPROVE_SECRETS_THRESHOLD],
    ["unlisted_dependency", depCategories.has("notify")],
    ["declared_effect", effects.some((e) => !APPROVE_GATING_EFFECTS.has(e))],
    ["network_declared", input.hasNetwork && input.secretsCount === 0],
  ]);

  const tableTier: RiskTier =
    input.validationErrors.length > 0
      ? "approve"
      : (R.firstBy(
          reasons.map((reason) => TABLE_REASON_TIERS[reason]),
          [(tier) => TIER_SEVERITY[tier], "desc"],
        ) ?? "auto");

  return match(tableTier)
    .with("auto", (): RiskTierResult => {
      const capReasons = raised<SkillRiskReason>([
        ["wasm_unhardened", !input.capabilities.wasmHardened],
        ["no_review_panel", !input.capabilities.reviewPanel],
      ]);
      return capReasons.length > 0
        ? { riskTier: "notify", reasons: [...reasons, ...capReasons] }
        : { riskTier: "auto", reasons };
    })
    .with("notify", "approve", (riskTier): RiskTierResult => ({ riskTier, reasons }))
    .exhaustive();
}

/**
 * The top-level package of every absolute import in `body`, at any depth:
 * `import a.b` and `from a.b import c` both name `a`. Throws when the parser
 * cannot load or returns no tree, as the classifier treats both.
 */
export function importRoots(body: string): Promise<ReadonlySet<string>> {
  return withPythonTree(body, (root) => {
    if (root === null) throw new Error("tree-sitter returned no tree for the skill body");
    return new Set(
      root.descendantsOfType(["import_statement", "import_from_statement"]).flatMap((node) => {
        if (node.type === "import_statement") return extractImportModules(node);
        const module = extractImportFromModule(node);
        return module ? [module] : [];
      }),
    );
  });
}

/**
 * The AST classifier as register runs it, on the tree the register-time gates
 * read: every undeclared effect in `REJECT_ON_UNDECLARED` rejects, whichever
 * row detected it. Throws on a walk failure, since register deploys no body
 * this path did not read.
 */
export function classifyWithAst(
  tree: SkillTree,
  manifest: SkillManifest,
  capabilities: SkillsCapabilities,
): ClassifierLog {
  return classify(detectHits(tree, manifest), manifest, capabilities, "register");
}

/**
 * The AST classifier as rollback runs it, which must not put a version that
 * worked out of reach: an undeclared effect rejects only when a row other than
 * a ctx row detected it, and a null tree classifies from the declarations
 * alone. Throws on a parser-load or walk failure, for `classifyManifest`'s
 * stub fallback.
 */
export async function classifyWithAstForRollback(
  manifest: SkillManifest,
  body: string,
  capabilities: SkillsCapabilities,
): Promise<ClassifierLog> {
  const hits = await withPythonTree(body, (root) =>
    root === null ? null : detectHits(readSkillTree(root), manifest),
  );
  return hits === null
    ? classifyFromDeclarationsOnly(manifest, capabilities)
    : classify(hits, manifest, capabilities, "rollback");
}

function classify(
  hits: readonly DetectedHit[],
  manifest: SkillManifest,
  capabilities: SkillsCapabilities,
  occasion: "register" | "rollback",
): ClassifierLog {
  const detectedSet = new Set<SkillEffect>(hits.map((h) => h.effect));
  const declaredSet = new Set<SkillEffect>(manifest.effects);
  // At rollback, effects only ctx rows detected count in the tier and stay
  // out of the validation errors.
  const rejecting = match(occasion)
    .with("register", () => hits)
    .with("rollback", () => hits.filter((h) => !h.ctx))
    .exhaustive();

  // Validation: dangerous effect detected but not declared → reject.
  // Build error messages from the per-rule labels so the operator
  // sees `undeclared effect 'sends_email' — found smtplib import`
  // instead of just the effect name.
  const validation_errors = R.unique(rejecting.map((h) => h.effect))
    .filter((effect) => REJECT_ON_UNDECLARED.has(effect) && !declaredSet.has(effect))
    .map((effect) => {
      const labels = [
        ...new Set(rejecting.filter((h) => h.effect === effect).map((h) => h.label)),
      ].sort();
      return `undeclared effect '${effect}' — code uses ${labels.join(", ")} but manifest does not declare it`;
    });

  const declaredSecrets = manifest.secrets.map((s) => (typeof s === "string" ? s : s.name));

  const { riskTier, reasons } = computeRiskTier({
    declared: manifest.effects,
    detected: [...detectedSet],
    validationErrors: validation_errors,
    tier: manifest.tier,
    secretsCount: declaredSecrets.length,
    hasNetwork: manifest.network !== undefined,
    dependencies: manifest.dependencies,
    capabilities,
  });

  return {
    classifier_version: AST_CLASSIFIER_VERSION,
    risk_tier: riskTier,
    declared_effects: manifest.effects,
    detected_effects: [...detectedSet].sort(),
    declared_secrets: declaredSecrets,
    declared_dependencies: manifest.dependencies,
    validation_errors,
    reasons,
    declared_network: manifest.network?.allow ?? null,
    capabilities: { ...capabilities },
  };
}

/**
 * Minimal "declaration-only" tier computation, used by
 * {@link classifyWithAstForRollback} when tree-sitter returns no tree. NOT
 * the fallback path — that's `classifier.ts`'s catch block calling the
 * stub. This is a defensive degenerate case.
 */
function classifyFromDeclarationsOnly(
  manifest: SkillManifest,
  capabilities: SkillsCapabilities,
): ClassifierLog {
  const declaredSecrets = manifest.secrets.map((s) => (typeof s === "string" ? s : s.name));
  const { riskTier, reasons } = computeRiskTier({
    declared: manifest.effects,
    detected: [],
    validationErrors: [],
    tier: manifest.tier,
    secretsCount: declaredSecrets.length,
    hasNetwork: manifest.network !== undefined,
    dependencies: manifest.dependencies,
    capabilities,
  });
  return {
    classifier_version: AST_CLASSIFIER_VERSION,
    risk_tier: riskTier,
    declared_effects: manifest.effects,
    detected_effects: [],
    declared_secrets: declaredSecrets,
    declared_dependencies: manifest.dependencies,
    validation_errors: [],
    reasons,
    declared_network: manifest.network?.allow ?? null,
    capabilities: { ...capabilities },
  };
}
