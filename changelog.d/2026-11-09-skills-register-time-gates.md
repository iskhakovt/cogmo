Register runs the verify stage's host-side gates before its transaction (design/skills.md → Verify stage → Register-time gates). Each gate rejects with one `errors` string per finding, `<id>: skills/<name>/skill.py:<line>:<column>: <message>`, or, for a wasm-lint finding, which has no column, `wasm_lint: skills/<name>/skill.py:<line>: <message>`.

- **Size:** `skill.py` within 400 lines and 48 000 characters.
- **Syntax:** the tree-sitter parse has no error.
- **Entrypoint:** one undecorated module-level `async def run`.
- **Dynamic code:** no `exec`, `eval`, `compile`, `__import__`, `importlib.import_module` or `getattr` with a computed name.
- **Effects:** literal `ctx.http` hosts and `ctx.secrets.get` names are checked against the manifest, through the URL parse and host match the `ctx` handler uses.
- **`ctx` calls:**
  - An undeclared `ctx.memory` or `ctx.files` call is rejected, as the handler refuses it at run time.
  - A `ctx.http` write request with no declared write effect is detected as `writes_user_data`, which raises the tier.
- **A gate that cannot run** (any throw from the parse or a walk) pauses register as `registrar_unavailable: parser`, and nothing deploys. The skill runner's boot fails when the grammar does not load.
- **Rollback:** an effect only the `ctx` calls show counts in the tier but does not refuse the rollback.
- **Authoring guide:** the generated `CLAUDE.md` states the gate rules, and the skills tool's guidance and the coding task's plan prompt state the Entrypoint rule's `run` signature.
