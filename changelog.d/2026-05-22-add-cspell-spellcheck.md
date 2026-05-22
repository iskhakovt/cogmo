### Spellcheck via cspell

Markdown design docs, changelog fragments, and TypeScript identifiers now get a CI-enforced spell pass. The new `pnpm spellcheck` script runs `cspell` against the whole tree (config in `cspell.config.yaml`), and the matching `spellcheck` CI job runs on every PR — *not* gated by the doc-only path filter, since prose changes are exactly where typos slip through today.

Tool choice: cspell over typos/codespell. The deciding factors were native pnpm install (no fragile binary wrapper), mature dictionary ecosystem (`@cspell/dict-{typescript,node,python,sql,k8s,bash,aws,html,en-gb,…}` covers Postgres/Pyodide/syscall vocabulary out of the box), and editor integration via the VS Code extension. Down-side is an allowlist for project-specific terms (`project-words.txt`), seeded from the initial run (~420 entries — product names, our own coined verbs like `dedup'ing` and `worktree's`, internal env vars, GitHub usernames cited in commit messages).

<!-- cspell:disable-next-line -->
Triage caught one real typo in `changelog.d/2026-05-07-fetch-url-browser-headers.md` (`refered` → `referred`) and one intentional typo-in-a-comment (`"htps://"`, demonstrating what a user might mistype into the repo-URL dialog) which now carries `// cspell:disable-next-line` so the global allowlist stays honest — a real misspelling introduced later still gets flagged.
