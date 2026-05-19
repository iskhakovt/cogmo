Coding-delegation plan mode no longer wedges on the CLI's `ExitPlanMode` permission round-trip — and we now run the real `claude` binary in integration tests so this class of regression fails CI instead of silently shipping. Pairs a Claude Code CLI bump (`2.1.119` → `2.1.138`) to align with the contract the new integration test pins.

## The wedge

`runClaudePlan` closed the CLI's stdin immediately after writing the prompt. Claude Code 2.x routes plan-mode completion through the `ExitPlanMode` tool, which asks for permission via stream-json `control_request` and blocks until a matching `control_response: allow` lands on stdin. With stdin closed, the response could never be written; the run sat idle for 5 minutes and got reaped by the wedge-resilience idle timer (`ExecTimeoutError(idle, 300000ms)`). Symptom from the user side: the plan text streamed into Telegram (visibly) → no approval keyboard → no error message → task vanished after 5 minutes of silence. Confirmed against two real failures (`019e40f6`, `019e4108`) and the orchestrator's `inngest/function.failed` path marking `planning → failed`.

Fix in `src/agent/coding/claude.ts`: `runClaudePlan` keeps stdin open until `parseClaudeStream` sees the `result` event (matching the execute runner's contract), reads `permission_request` events inline, and auto-allows them via a shared `writeControlResponse` helper hoisted out of `runClaudeExecute`. The auto-allow is unconditional, not gated to `ExitPlanMode`: CLI 2.1.x's plan flow involves multiple intermediate tool calls (Read, Bash, Grep, then a `Write` to `/home/vscode/.claude/plans/<task>.md`, then `ExitPlanMode`), each gated through the same control channel. Denying any of them wedges the CLI the same way — the model has no recovery path. The CLI's `--permission-mode plan` is the policy authority; if it routes a request to our control channel, it's already considered plan-mode-safe, and our job is to unblock the round-trip. The orchestrator's plan loop (`src/agent/coding/orchestrator.ts`) is unchanged on the hot path; only the stale "permission_request not emitted in plan mode" comment is replaced with a present-tense description of what now happens.

## Why the existing suite missed it

The plan-mode unit fixtures in `claude.test.ts` were hand-written to emit `text_delta` → `result` with no `assistant{tool_use: ExitPlanMode}` and no `control_request` — they encoded what the developer believed the CLI did, not what it actually emits. The execute-mode control_request tests were thorough but never reached `backend.plan()`. The just-landed Daytona conformance test exercised the SDK ↔ Daytona REST/WS layer, not the CLI subprocess. Sysbox-e2e's path filter covered `src/agent/coding/**` but the workflow only ran supervisor + skills tests; no test ever booted the actual `claude` binary inside the production base image.

## New coverage

Two layers.

**Unit (`claude.test.ts`):** four new tests under a `describe("ExitPlanMode permission round-trip")` block — auto-allow + plan_ready round-trip, the regression-specific "stdin stays open until control_response is written" assertion (the test that would have caught the original wedge), auto-allow of non-ExitPlanMode plan-mode tools (Write to the CLI's plan file — the case that motivated dropping the original deny path), and dedupe of duplicate request ids.

**Integration (`claude-cli.integration.test.ts`):** boots a `cogmo-devbase:test` container via `LocalDockerSandboxClient` with `ANTHROPIC_BASE_URL` pointed at the existing llmock (already configured to proxy `https://api.anthropic.com`), pins `ANTHROPIC_MODEL=claude-haiku-4-5-20251001` + `MAX_THINKING_TOKENS=0` for record-mode cost and fidelity, runs `backend.plan()` end-to-end against a one-line prompt, and asserts the event sequence reaches `plan_ready` + `complete` with `permission_request` never escaping to the caller and with `ExitPlanMode` appearing in the captured `tool_call` list. Replay (CI default) is free; record uses the existing `RECORD=1 ANTHROPIC_API_KEY=…` pattern that the fal / voice / daytona / xai mocks already share. The container reaches llmock by resolving the docker bridge gateway via `docker.getNetwork("bridge").inspect()` — `host.docker.internal` isn't wired through the supervisor and the test seam stays contained to the test file. A small bind-mounted `/workspace` with a single `greet.ts` file gives the plan-mode model something concrete to investigate (an empty workspace makes the model bail without ever calling `ExitPlanMode`, leaving the regression untested).

Three findings while building this test, each captured in code or comments where future maintainers will hit them:

1. **aimock 1.18 corrupted Anthropic SSE streams enough to break record/replay** — multi-turn runs ran fine on the first turn and then failed every subsequent turn with `Invalid signature in thinking block` 400s from anthropic. Bumping to 1.26.1 (already on `main` via #298 — local node_modules just hadn't been re-installed) fixed it; the wedge debug session caught the version skew.

2. **Disabling extended thinking is mandatory for record/replay fidelity** — even on 1.26.1, the SSE-to-fixture "collapse" step doesn't round-trip Anthropic's signed thinking-block payloads byte-for-byte. Setting `MAX_THINKING_TOKENS=0` keeps the CLI on single-block assistant responses that the proxy can faithfully replay. Documented at the env-var pin site.

3. **The CLI's plan-mode system-reminder embeds a per-session random plan-file slug** (e.g. `/home/vscode/.claude/plans/task-read-workspace-greet-ts-breezy-kitten.md`) into every user message; record-vs-replay slug mismatch makes every turn after the first miss its fixture. The normalizer in `test/llmock-setup.ts` now collapses `.claude/plans/task-*.md` to a stable `task-[SLUG].md` token, so the slug stops being part of the matching key.

## CLI bump

Bumps `CLAUDE_CODE_VERSION` in `images/devbase/Dockerfile` from `2.1.119` → `2.1.138` (latest stable). 19 patch releases of upstream fixes, vetted by the new integration test running against the real binary. The whole point of building the test was to make CLI bumps safe; refusing to use it on the first opportunity defeats the purpose. The Dockerfile comment ("Bump deliberately in the same PR that bumps the parser") is now actually enforced by CI.

## CI wiring

`sysbox-e2e.yml` now bakes both `skills` and `devbase` targets (was: skills only), adds `images/devbase/**` to the path filter, and runs `claude-cli.integration.test.ts` alongside the existing sysbox supervisor + skills tests. The CLI's actual stream-json behavior is now re-derived from the captured API conversation by running the real `claude` binary on every CI run; a future CLI bump that changes the permission protocol fails this test loud instead of shipping silent regressions.
