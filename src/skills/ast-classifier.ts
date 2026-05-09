/**
 * AST-based risk classifier for skill bodies. Walks the Python source
 * via tree-sitter and detects undeclared effects (process spawn,
 * filesystem mutation, external messaging, financial APIs) that the
 * manifest didn't list. Detection promotes the deploy's risk tier and,
 * for "dangerous-when-undeclared" categories, *rejects* the deploy
 * with `validation_errors` describing the manifest-vs-code mismatch.
 *
 * **THIS IS NOT A SECURITY BOUNDARY.** A skill can `getattr(
 * __import__("os"), "system")(...)`, alias a module under a different
 * name, or use a third-party SDK we don't have a rule for, and bypass
 * detection. The actual security boundaries are sysbox isolation
 * (tier-2), the `effects`-driven secret allowlist (P3.4), and the
 * `approve` tier for risky skills. AST lint serves two narrower
 * purposes:
 *
 *   1. **UX gate** — force the manifest's `effects:` to track what
 *      the body actually does, so a skill author can't ship something
 *      that `smtplib.SMTP(...)`-s without saying so.
 *
 *   2. **Tier promoter** — when nothing dangerous is detected AND
 *      nothing dangerous is declared, promote to `auto` (no human
 *      tap, ships immediately).
 *
 * Rules live in `ast-rules.ts` as pure data — adding "rule X marks
 * effect Y" is a new row, no logic change. Parser load and walking
 * happen in this file.
 *
 * Failure mode: any unhandled error in this path (parser load, walk,
 * unexpected node shape) is caught at the call site in `classifier.ts`
 * and falls back to the declaration-only stub. We log the throw with
 * a `skill_classifier_fallback_total` counter so an operator can see
 * when the AST path is silently degrading.
 */

import { readFileSync } from "node:fs";
import { resolve as resolvePath } from "node:path";
import { Language, type Node, Parser } from "web-tree-sitter";
import { logger } from "../logger.js";
import {
  APPROVE_GATING_EFFECTS,
  APPROVE_SECRETS_THRESHOLD,
  CALL_RULES,
  IMPORT_RULES,
  REJECT_ON_UNDECLARED,
} from "./ast-rules.js";
import type { ClassifierLog, SkillEffect, SkillManifest } from "./types.js";

export const AST_CLASSIFIER_VERSION = "ast-1";

const log = logger.child({ component: "skills.ast-classifier" });

/**
 * Resolve `vendor/tree-sitter-python/tree-sitter-python.wasm` from
 * `process.cwd()`. Bootstrap convention is "cwd is project root" — see
 * `loadHindsightCompat` in `src/boot/checks.ts` for the precedent.
 * tsup flattens the build output and breaks `import.meta.url`-relative
 * resolution from `dist/`, so we don't try to chase the source-tree
 * path; the vendor directory is shipped to `/app/vendor` in the Docker
 * image alongside `dist/`.
 */
const WASM_PATH = resolvePath(
  process.cwd(),
  "vendor",
  "tree-sitter-python",
  "tree-sitter-python.wasm",
);

/**
 * Lazy-init parser. The first call pays the WASM load (~tens of ms);
 * subsequent calls share the singleton. `reset` is exported for tests
 * that want to exercise the load-failure path.
 */
let parserPromise: Promise<Parser> | null = null;

async function getParser(): Promise<Parser> {
  if (!parserPromise) {
    parserPromise = (async () => {
      await Parser.init();
      const langBytes = readFileSync(WASM_PATH);
      const Python = await Language.load(langBytes);
      const parser = new Parser();
      parser.setLanguage(Python);
      return parser;
    })().catch((err) => {
      // Reset on failure so a transient init error (e.g., missing
      // wasm file at runtime in some pathological deploy) gets
      // retried on the next register, not cached forever.
      parserPromise = null;
      throw err;
    });
  }
  return parserPromise;
}

/** Test-only — drop the cached parser so next call re-initializes. */
export function __resetParserForTests(): void {
  parserPromise = null;
}

interface DetectedHit {
  effect: SkillEffect;
  label: string;
}

/**
 * Walk a tree-sitter Python tree and return one `DetectedHit` per
 * matched import or call. Multiple hits per effect are deduped at the
 * caller; we keep them all here so the call sites can surface
 * specific labels in `validation_errors` ("undeclared effect:
 * sends_email — saw `smtplib`").
 */
function detectHits(rootNode: Node): DetectedHit[] {
  const hits: DetectedHit[] = [];

  // Walk via cursor — far cheaper than recursive `namedChild(i)` on
  // large trees. We descend into every named child but skip token
  // nodes (no children to look at). The cursor wraps a WASM heap
  // allocation that the JS GC can't see; release it in a `finally`
  // so a thrown rule (or a future panic in a child) can't leak.
  const cursor = rootNode.walk();
  try {
    function visit(): void {
      const node = cursor.currentNode;
      switch (node.type) {
        case "import_statement":
          for (const name of extractImportModules(node)) {
            for (const rule of IMPORT_RULES) {
              if (rule.module === name) {
                hits.push({ effect: rule.effect, label: rule.label });
              }
            }
          }
          break;
        case "import_from_statement": {
          const module = extractImportFromModule(node);
          if (module) {
            for (const rule of IMPORT_RULES) {
              if (rule.module === module) {
                hits.push({ effect: rule.effect, label: rule.label });
              }
            }
          }
          break;
        }
        case "call":
          matchCall(node, hits);
          break;
      }

      if (cursor.gotoFirstChild()) {
        do {
          visit();
        } while (cursor.gotoNextSibling());
        cursor.gotoParent();
      }
    }

    visit();
  } finally {
    cursor.delete();
  }
  return hits;
}

/**
 * `import a, b.c, d` → ["a", "b", "d"]. We collapse dotted names to
 * the leftmost identifier because that's the package root, which is
 * what our import-rules table keys on (we don't want to match
 * `email.message` separately from `email.mime.text`).
 */
function extractImportModules(node: Node): string[] {
  const names: string[] = [];
  for (let i = 0; i < node.namedChildCount; i++) {
    const child = node.namedChild(i);
    if (!child) continue;
    if (child.type === "dotted_name" || child.type === "aliased_import") {
      const dotted = child.type === "dotted_name" ? child : child.namedChild(0);
      if (dotted && dotted.type === "dotted_name") {
        const first = dotted.namedChild(0);
        if (first?.type === "identifier") names.push(first.text);
      }
    }
  }
  return names;
}

/** `from a.b.c import x` → "a"; `from . import x` → null (relative). */
function extractImportFromModule(node: Node): string | null {
  // `module_name` field is the dotted source. tree-sitter-python uses
  // a positional layout — first named child is the module path
  // (could be a `dotted_name` or a `relative_import`). We only care
  // about absolute imports; relative imports inside a skill don't map
  // to standalone packages.
  const firstChild = node.namedChild(0);
  if (!firstChild || firstChild.type !== "dotted_name") return null;
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
      if (rule.object === null && rule.attr === name) {
        if (rule.argPredicate === undefined || matchesArgPredicate(node, rule.argPredicate)) {
          hits.push({ effect: rule.effect, label: rule.label });
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
      if (rule.attr !== attrName) continue;
      // Two match modes against `rule.object`:
      //   - rule.object === objectName (with both non-null) — qualified call
      //   - rule.object === null — attribute call where receiver is anything;
      //     used for `.write_text` / `.write_bytes` on Path-like values
      const objectMatches =
        rule.object === null || (objectName !== null && rule.object === objectName);
      if (!objectMatches) continue;
      if (rule.argPredicate === undefined || matchesArgPredicate(node, rule.argPredicate)) {
        hits.push({ effect: rule.effect, label: rule.label });
      }
    }
  }
}

/**
 * Predicate runners. Today we only need `open_write_mode`: match if
 * `args[1]` is a string literal whose Python-string value contains
 * a write-mode flag. Default mode is `"r"` (read) when omitted.
 */
function matchesArgPredicate(callNode: Node, predicate: "open_write_mode"): boolean {
  if (predicate === "open_write_mode") {
    const args = callNode.childForFieldName("arguments");
    if (!args) return false;
    const second = args.namedChild(1);
    if (!second) return false;
    if (second.type !== "string") return false;
    const literal = stringLiteralValue(second);
    if (literal === null) return false;
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
function stringLiteralValue(node: Node): string | null {
  let acc = "";
  for (let i = 0; i < node.namedChildCount; i++) {
    const child = node.namedChild(i);
    if (!child) continue;
    if (child.type === "string_content") acc += child.text;
  }
  return acc;
}

/**
 * Compute the `risk_tier` for a deploy given declared + detected
 * effects, manifest tier (wasm/container), and secrets count.
 *
 * Order:
 *   1. If any `validation_errors` were produced (undeclared dangerous
 *      effect), the deploy will be rejected upstream regardless. We
 *      stamp `approve` defensively so that a hypothetical "rejected
 *      but recorded" path doesn't accidentally land an `auto` tier in
 *      the audit log.
 *   2. Detected effects that map into `APPROVE_GATING_EFFECTS` or
 *      declared effects in the same set → `approve`.
 *   3. tier=container or secrets >= threshold → `approve`.
 *   4. Anything else with declared OR detected effects → `notify`.
 *   5. Empty effects + tier=wasm + few secrets → `auto`.
 */
function computeRiskTier(opts: {
  declared: ReadonlyArray<SkillEffect>;
  detected: ReadonlyArray<SkillEffect>;
  validationErrors: ReadonlyArray<string>;
  tier: SkillManifest["tier"];
  secretsCount: number;
}): ClassifierLog["risk_tier"] {
  if (opts.validationErrors.length > 0) return "approve";

  const all = new Set<SkillEffect>([...opts.declared, ...opts.detected]);
  for (const e of all) {
    if (APPROVE_GATING_EFFECTS.has(e)) return "approve";
  }
  if (opts.tier === "container") return "approve";
  if (opts.secretsCount >= APPROVE_SECRETS_THRESHOLD) return "approve";
  if (all.size > 0) return "notify";
  return "auto";
}

/**
 * Run the AST classifier. Throws on parser-load or walk failure; the
 * caller is responsible for catching and falling back to the stub.
 */
export async function classifyWithAst(
  manifest: SkillManifest,
  body: string,
): Promise<ClassifierLog> {
  const parser = await getParser();
  const tree = parser.parse(body);
  if (!tree) {
    // Defensive — parse() returns null only on extremely malformed
    // input that the WASM allocator rejects. Fall back to "no hits"
    // and let the manifest declarations alone drive the tier.
    log.warn(
      { bodyLength: body.length },
      "tree-sitter returned null tree; classifying as no-detect",
    );
    return classifyFromDeclarationsOnly(manifest);
  }

  // `tree.delete()` releases the WASM-heap allocation backing the
  // tree. JS GC can't see it; pair the call with the parse in a
  // try/finally so a throw inside `detectHits` can't leak.
  let hits: DetectedHit[];
  try {
    hits = detectHits(tree.rootNode);
  } finally {
    tree.delete();
  }

  const detectedSet = new Set<SkillEffect>(hits.map((h) => h.effect));
  const declaredSet = new Set<SkillEffect>(manifest.effects);

  // Validation: dangerous effect detected but not declared → reject.
  // Build error messages from the per-rule labels so the operator
  // sees `undeclared effect 'sends_email' — found smtplib import`
  // instead of just the effect name.
  const validation_errors: string[] = [];
  for (const effect of detectedSet) {
    if (REJECT_ON_UNDECLARED.has(effect) && !declaredSet.has(effect)) {
      const labels = [
        ...new Set(hits.filter((h) => h.effect === effect).map((h) => h.label)),
      ].sort();
      validation_errors.push(
        `undeclared effect '${effect}' — code uses ${labels.join(", ")} but manifest does not declare it`,
      );
    }
  }

  const declaredSecrets = manifest.secrets.map((s) => (typeof s === "string" ? s : s.name));

  const risk_tier = computeRiskTier({
    declared: manifest.effects,
    detected: [...detectedSet],
    validationErrors: validation_errors,
    tier: manifest.tier,
    secretsCount: declaredSecrets.length,
  });

  return {
    classifier_version: AST_CLASSIFIER_VERSION,
    risk_tier,
    declared_effects: manifest.effects,
    detected_effects: [...detectedSet].sort(),
    declared_secrets: declaredSecrets,
    validation_errors,
  };
}

/**
 * Minimal "declaration-only" tier computation, used inside
 * {@link classifyWithAst} when tree-sitter returns no tree. NOT the
 * fallback path — that's `classifier.ts`'s catch block calling the
 * stub. This is a defensive degenerate case.
 */
function classifyFromDeclarationsOnly(manifest: SkillManifest): ClassifierLog {
  const declaredSecrets = manifest.secrets.map((s) => (typeof s === "string" ? s : s.name));
  const risk_tier = computeRiskTier({
    declared: manifest.effects,
    detected: [],
    validationErrors: [],
    tier: manifest.tier,
    secretsCount: declaredSecrets.length,
  });
  return {
    classifier_version: AST_CLASSIFIER_VERSION,
    risk_tier,
    declared_effects: manifest.effects,
    detected_effects: [],
    declared_secrets: declaredSecrets,
    validation_errors: [],
  };
}
