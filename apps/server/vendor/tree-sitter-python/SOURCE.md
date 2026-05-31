# tree-sitter-python.wasm

Prebuilt tree-sitter Python grammar, used by `src/skills/ast-classifier.ts`
to walk Python skill bodies and detect undeclared effects + promote
read-only skills to the `auto` risk tier.

## Source

Copied from `@vscode/tree-sitter-wasm@0.3.1` →
`package/wasm/tree-sitter-python.wasm` (Microsoft / VS Code's curated
multi-language WASM bundle — the one VS Code itself uses for Python
parsing across millions of installs).

We vendor a single file rather than installing the full
`@vscode/tree-sitter-wasm` package because we only need one out of the
16 grammars it bundles; pulling the whole 22 MB into `node_modules` for
458 KB of Python is wasteful.

## Refresh

To bump to a newer version:

```sh
VERSION=0.4.0  # next @vscode/tree-sitter-wasm release
curl -sL "https://registry.npmjs.org/@vscode/tree-sitter-wasm/-/tree-sitter-wasm-${VERSION}.tgz" \
  | tar -xz -O package/wasm/tree-sitter-python.wasm \
  > vendor/tree-sitter-python/tree-sitter-python.wasm
```

Then run `pnpm test` — fixture suite in `src/skills/ast-classifier.test.ts`
exercises the rules in `src/skills/ast-rules.ts` against the new
grammar. Bump this file's "Source" version line on a successful run.

## License

MIT — same as upstream `@vscode/tree-sitter-wasm` (Microsoft) and
`tree-sitter-python` (the grammar itself).
