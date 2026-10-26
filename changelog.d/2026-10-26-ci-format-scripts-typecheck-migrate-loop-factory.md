**CI gates `ruff format --check` in the skills-runtime job**, and the four unformatted files under `images/skills/` are formatted (AST-identical).

**`pnpm typecheck` covers `apps/server/scripts/`** through the package tsconfig's `include`, so a rename on the `src` side breaks CI rather than a dev's next `tsx` run. `tokei.ts` reads `.gitattributes` from the repo root, so `pnpm tokei` works; the dead `simplify-fixtures.ts` is gone.

**`pnpm db:migrate` runs the per-file migrator** (`scripts/migrate.ts`: `migratePerFile` under the bootstrap lock, as boot does), so an `ALTER TYPE … ADD VALUE` split pair applies on an upgrade. It recognises a database `drizzle-kit migrate` brought up.

**`design/testing.md` → Skill-Authoring Integration describes the shipped suite** and is `[confirmed]`: a stdlib-only `tier: wasm` skill, auto-registered on `coding/task/pr-opened`, a local bare remote and stub Octokit in replay, and the branch fixture copied by hand from the recorded PR head.

**Agent-loop stubs in the handle-message and stage tests are typed** (`vi.fn<typeof runStreamingAgentLoop>()`) and built through a shared `loopResult()` factory, so a new `AgentLoopResult` field breaks them at compile time. `StreamedOutput` is `AgentLoopResult["streamed"]`, and a replay assertion that read the transaction placeholder instead of the message params checks the params.
