import { readFileSync } from "node:fs";
import { resolve as resolvePath } from "node:path";
import { Language, type Node, Parser } from "web-tree-sitter";

/**
 * The tree-sitter Python parser the register-time gates and the classifier
 * share (design/skills.md → Classifier → Implementation).
 *
 * The grammar resolves from `process.cwd()`: bootstrap's convention is that
 * cwd is the project root (`loadHindsightCompat` in `src/boot/checks.ts`), and
 * tsup flattens the build so `import.meta.url` cannot locate `vendor/` from
 * `dist/`. The image ships `vendor/` to `/app/vendor` beside `dist/`.
 */
const DEFAULT_WASM_PATH = resolvePath(
  process.cwd(),
  "vendor",
  "tree-sitter-python",
  "tree-sitter-python.wasm",
);

/** The grammar's path; only {@link __setWasmPathForTests} changes it. */
let wasmPath = DEFAULT_WASM_PATH;

/**
 * One parser per process, loaded on first use. Concurrent callers await the
 * same promise, which is safe on Node's single thread: the parser's WASM heap
 * changes only inside `parser.parse()`, which runs to completion before
 * yielding. Worker threads would each need their own `Parser`.
 */
let parserPromise: Promise<Parser> | null = null;

function pythonParser(): Promise<Parser> {
  if (!parserPromise) {
    parserPromise = (async () => {
      await Parser.init();
      const python = await Language.load(readFileSync(wasmPath));
      const parser = new Parser();
      parser.setLanguage(python);
      return parser;
    })().catch((err) => {
      // A failed load is retried by the next caller rather than cached.
      parserPromise = null;
      throw err;
    });
  }
  return parserPromise;
}

/**
 * Load the grammar, throwing when it cannot load. `bootstrapSkillRunner`
 * calls it so a broken image fails at startup rather than at the first
 * register.
 */
export async function loadPythonParser(): Promise<void> {
  await pythonParser();
}

/**
 * Parse `source` and hand its root to `read`, or null when tree-sitter
 * returns no tree. The tree lives in the WASM heap, which the JS GC cannot
 * see, so it is deleted once `read` returns or throws; `read` must not keep a
 * node. Throws when the grammar cannot load.
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

/**
 * Test-only — point the parser at another grammar file, or a missing one to
 * force a load failure; `null` restores the default. Pair it with
 * {@link __resetParserForTests}.
 */
export function __setWasmPathForTests(path: string | null): void {
  wasmPath = path ?? DEFAULT_WASM_PATH;
}
