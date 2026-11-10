import { readFileSync } from "node:fs";
import { Language, type Node, Parser } from "web-tree-sitter";
import { describeError } from "../util/describe-error.js";

/**
 * The tree-sitter Python parser the register-time gates and the classifier
 * share (design/skills.md → Classifier → Implementation).
 *
 * The grammar's path comes from the composition root
 * ({@link configurePythonParser}): `bootstrapSkillRunner` names the vendored
 * grammar under the server's working directory (`vendoredGrammarPath`), and
 * the gates CLI the file beside its bundle (design/skills.md → The gates in
 * verify).
 */

/** The grammar's path; null until the composition root configures it. */
let grammarPath: string | null = null;

/**
 * One parser per process, loaded on first use. Concurrent callers await the
 * same promise, which is safe on Node's single thread: the parser's WASM heap
 * changes only inside `parser.parse()`, which runs to completion before
 * yielding. Worker threads would each need their own `Parser`.
 */
let parserPromise: Promise<Parser> | null = null;

/**
 * Point the parser at the grammar file at `path`; the composition root calls
 * it before any parse. The grammar loads on first use, or at
 * {@link loadPythonParser}. A path other than the configured one drops the
 * loaded parser, so the next use loads the new grammar.
 */
export function configurePythonParser(path: string): void {
  if (path === grammarPath) return;
  grammarPath = path;
  parserPromise = null;
}

function pythonParser(): Promise<Parser> {
  const path = grammarPath;
  if (path === null) {
    return Promise.reject(
      new Error(
        "the Python grammar is not configured; the composition root calls configurePythonParser before any parse",
      ),
    );
  }
  if (parserPromise === null) {
    // A failed load is retried by the next caller rather than cached.
    const loading: Promise<Parser> = loadParser(path).catch((e: unknown) => {
      if (parserPromise === loading) parserPromise = null;
      throw e;
    });
    parserPromise = loading;
  }
  return parserPromise;
}

/** Load web-tree-sitter's runtime, then the grammar at `path`. */
async function loadParser(path: string): Promise<Parser> {
  await loadNamed("web-tree-sitter's runtime (web-tree-sitter.wasm)", () => Parser.init());
  const python = await loadNamed(`the Python grammar at ${path}`, async () =>
    Language.load(readFileSync(path)),
  );
  const parser = new Parser();
  parser.setLanguage(python);
  return parser;
}

/** `load()`, its failure naming `what` did not load, since web-tree-sitter's errors name no file. */
async function loadNamed<T>(what: string, load: () => Promise<T>): Promise<T> {
  try {
    return await load();
  } catch (e) {
    throw new Error(`${what} did not load: ${describeError(e)}`);
  }
}

/**
 * Load the configured grammar, throwing when none is configured or it cannot
 * load. `bootstrapSkillRunner` calls it so a broken image fails at startup
 * rather than at the first register.
 */
export async function loadPythonParser(): Promise<void> {
  await pythonParser();
}

/**
 * Parse `source` and hand its root to `read`, or null when tree-sitter
 * returns no tree. The tree lives in the WASM heap, which the JS GC cannot
 * see, so it is deleted once `read` returns or throws; `read` must not keep a
 * node. Throws when no grammar is configured or it cannot load.
 */
export async function withPythonTree<T>(
  source: string,
  read: (root: Node | null) => T,
): Promise<T> {
  const parser = await pythonParser();
  const tree = parser.parse(source);
  if (tree === null) return read(null);
  try {
    return read(tree.rootNode);
  } finally {
    tree.delete();
  }
}

/** Test-only — drop the cached parser so the next call loads it again. */
export function __resetParserForTests(): void {
  parserPromise = null;
}
