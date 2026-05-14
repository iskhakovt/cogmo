Closed five of six unit-test coverage gaps surfaced by the merged
unit+integration coverage sweep (`coverage/merged/`). Each closure targets
a specific failure-mode contract that integration tests exercise only
along the happy path; the new tests pin the rejection/branch matrix so
silent regressions surface immediately.

- **Telegram adapter** — 20 new tests in `src/transport/adapters/telegram/index.test.ts`
  covering the inline-keyboard callback dispatch (plan / permission /
  skills-approval handlers), unauthorised-user + emit-failure branches on
  the text path, `deliver()`'s HTML-parse fallback, and the
  generated-document mid-stream delivery path that shipped in PR #223
  without unit coverage.
- **Transport API** — 11 new tests for `Transport.skills.{approveDeploy,denyDeploy}`
  in `transport-skills.test.ts` plus 27 tests in a new
  `transport-mcp.test.ts` covering the full MCP admin surface
  (`addServer`, `removeServer`, `listServers`, `approveServer`,
  `approveTool`, `rejectTool`, `toolBudget`). Locks in error-code
  mapping for `UniqueViolationError`, `McpInvalidServerNameError`,
  `McpServerNotFoundError`, and Zod safeParse failures.
- **Skills runner** — 4 new rejection-matrix tests in
  `runner.register.test.ts` (`deploy_not_found`, `deploy_not_pending`,
  `non_fast_forward_at_approve_time`, `target_missing_source` on both
  `approveDeploy` and `rollback`).
- **Sandbox supervisor** — 11 new tests in `supervisor.test.ts` for
  `resume()`, `tryResumeByTaskId()`, and `ensureImagePresent()`. Covers
  the crash-recovery contract documented in `design/crash-recovery.md`:
  depth-0 filter, docker-404 swallow on stale rows, paused-state skip,
  followProgress error propagation on image-pull.
- **Worker-sysbox pool** — 1 new test in `pool.test.ts` for the
  background replacement-spawn failure path (pool drops below min, no
  queued waiter, replacement spawn errors → catch logs warn and the
  completed invoke's result stands).
- **Round-up** — 2 new commit-push failure-exit tests, 6 new
  profile-dialog `friendlyError` mapping tests, 3 new cleanup-orphan
  sweeper edge tests (repo-row-gone, unparseable-remote, GitHub 404/422
  as "ref already gone").

One related gap deferred: worker-wasm host lifecycle failures
(fatal/exit-before-ready/grace timeout) need a mocked
`node:worker_threads.Worker`, which the existing real-Pyodide
`host.test.ts` doesn't have. Kept as a standalone p3 in `todo.md`.

Total: 9 test files touched, +85 tests added (245 → 330 across these
files), all passing under `pnpm test`. Coverage utilities added at
`scripts/merge-coverage.ts`, `scripts/coverage-gaps.ts`, and
`scripts/coverage-gaps-detail.ts` for future sweeps.

### Sandbox: `DockerFacade` and `mock<T>()` cleanup

The new tests (and a few pre-existing ones) relied on `as unknown as Docker`
casts to stub the dockerode `Docker` class — a ~50-method type where the
supervisor only uses ~7 methods. Replaced with a project-owned
`DockerFacade` interface (`src/sandbox/docker-facade.ts`) that captures
exactly the surface the supervisor + runtime helper consume:

- `info` / `getContainer` / `getImage` / `pull` / `listContainers` /
  `createContainer` / `modem` at the top level
- Narrow `DockerContainer`, `DockerExec`, `DockerImage`, `DockerModem`
  shapes for the methods called downstream (with narrow return types
  like `ContainerInspect { State: { Status: string } }` instead of
  dockerode's dense `ContainerInspectInfo`)

The real `Docker` class from dockerode structurally satisfies `DockerFacade`,
so the boot site (`src/index.ts`) keeps `const docker = new Docker()` without
a cast. Tests now build stubs via `mock<DockerFacade>()` +
`mock<DockerContainer>()`, eliminating the wide `as unknown as Docker` cast.
Two pre-existing kill-failure / dispose-hang fixtures keep a narrowed
`as unknown as DockerFacade` per the project memory rule about stateful test
fixtures.

Inngest mocks (`transport-skills.test.ts`, `transport-mcp.test.ts`) similarly
swapped from `{ send: ... } as unknown as Inngest` to `mock<Inngest>()` +
`.send.mockResolvedValue({ ids: [] })`.

Production-code change is minimal: `supervisor.ts`, `runtime.ts`,
`factory.ts`, and `sandbox/index.ts` accept `DockerFacade` instead of
`Docker`. `reaper.ts` and `src/index.ts:sandboxDocker` stay on raw
`Docker` because the reaper uses a wider dockerode surface (networks,
volumes) that the facade doesn't cover yet.
