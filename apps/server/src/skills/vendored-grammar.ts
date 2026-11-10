import { join } from "node:path";

/**
 * The tree-sitter Python grammar vendored under `root`, the server package's
 * directory: `vendor/` in the source tree, and `/app/vendor` beside `dist/` in
 * the image (design/skills.md → Classifier → Implementation). The server's
 * composition root hands it to `configurePythonParser`, and the gates bundle
 * copies it beside `gates.mjs`.
 */
export function vendoredGrammarPath(root: string): string {
  return join(root, "vendor", "tree-sitter-python", "tree-sitter-python.wasm");
}
