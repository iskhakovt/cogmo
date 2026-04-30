# Testing Retrospective: PRs #76, #78, #80, #86

## Methodology (what good looks like)

The patterns from PR #87 (skills P3.1 tier1) that produced 1696 passing tests across 99 unit files + 4 integration files + 5 e2e tests:

1. **Per-Zod-schema boundary tests** — every JSONB column has a Zod schema, enforced on both read and write at the store boundary. Unit tests parse on read via raw SQL bypass (`UPDATE ... SET col = bad_json WHERE ... ; expect(store.get(...)).rejects.toThrow()`). Example: `skills/store/store.test.ts` line 219 (`rejects malformed classifier_log via raw SQL on read`).

2. **Discriminated-union exhaustive parse tests** — every union type path exercised. For `CodingEvent` union in slice 2+, test every event kind (`session_started`, `text_delta`, `tool_call`, `plan_ready`, `complete`) with valid and invalid values.

3. **Store happy-path + error-path coverage** — not just "insert then retrieve"; test atomic multi-field state (e.g., `worktreeAssignment` JSONB null until both branch+worktreePath set); idempotent replay; missing-row behaviors; constraint collisions (UNIQUE, FK).

4. **Integration tests with real services** — Postgres (not PGlite), real Hindsight if used, real Inngest schema, real external APIs mocked via scoped fetch interceptors (not global `vi.mock()`). Example: slice 4's `verify-orchestrator.integration.test.ts` runs real Gitea container + Octokit payload capture.

5. **E2e tests on production Docker image** — migrations applied, distroless constraints, sysbox runtime detection, file ownership, bundled assets found at expected paths.

6. **Error-path coverage matrix per module** — per CLI tool / orchestrator function, test: invalid args (per Zod schema), missing/required effects, external service timeout/auth failure, concurrent contention, idempotent retries, cleanup on crash.

7. **Resource cleanup invariants** — TTL expiry, orphan reaper, container teardown on task failure, credential wipe (askpass dir), advisory lock release under contention, double-tap prevention (idempotent event handlers).

8. **Audit row invariants** — "every X produces a Y" — every context call logged, every task change emits an event, every tool decision recorded. Tests verify the audit row has the right shape and didn't swallow critical data.

9. **CLI exit-code matrices** — every command surface (Telegram `/repo`, agent tools) tested for exit codes: success paths (0), invalid args (1?), auth failures, not-found, already-exists, in-use.

10. **Version pinning + breaking-change coverage** — runtime deps with breaking versions (dockerode, octokit, sysbox image tags, claude CLI flags) tested via pinned version in fixtures and explicit version-bumping tests.

---

## Per-PR Audit

### PR #76 — slice 1 (autonomous coding plan-only end-to-end)

**Shipped:** Sandbox primitives (`containers`, `cogmo_instances` stores + supervisor + sysbox detection), Claude Code plan-only backend with stream-json parsing, worktree allocator, Inngest orchestrator, Telegram `/repo` commands.

**Tests added:** 60 unit test files (791 tests), 8 integration tests (supervisor against runc), 2 e2e tests (sysbox userns isolation).

#### Unit gaps

- **Sandbox store raw-SQL bypass missing.** `src/sandbox/store/store.test.ts` validates JSONB round-trip but doesn't corrupt the JSONB via raw SQL and expect the parser to reject on read. Example: no test `rejects malformed labels via raw SQL on read` (like `skills/store/store.test.ts` line 219). `ContainerLabelsSchema` + `ResourceLimitsSchema` have no mutation-and-read tests.
  - **Remediation:** Add 2-3 tests per JSONB column (labels, resource_limits, in networks/volumes) using `db.execute(sql\`UPDATE ... SET col = '{"junk":true}'::jsonb ...\`)` and asserting the read path throws.

- **Worktree allocator idempotent-replay missing.** `worktree.test.ts` has 114 lines across ~3 tests. Orchestrator's `allocate-worktree` step can fire twice (first call persisted then crashed before returning). The code does idempotent `git worktree add` reconcile, but there's no test asserting **"second call with same task id re-derives the same branch name and succeeds"**. Current tests are shallow (`mkdir` stub, no actual git).
  - **Remediation:** Add a real-git integration test (in `src/agent/coding/worktree.integration.test.ts`) that creates a worktree, calls allocate twice with the same inputs, asserts both succeed and leave the same worktree checked out.

- **Supervisor crash-recovery missing.** `supervisor.test.ts` lines 8-100 show a stub-Docker setup; there's a note about `supervisor.integration.test.ts` covering "full Docker-side behavior". However, the crash-recovery flow — **"instance crashed, Cogmo restart, orphan container detected and reaped"** — is not tested in the integration tier (reaper cron wasn't added until slice 3). Current `supervisor.integration.test.ts` (305 lines) only tests happy-path container creation, not restart+orphan recovery.
  - **Remediation:** Deferred to slice 3 audit (reaper tests added there), but note it wasn't in scope for slice 1.

- **Inngest orchestrator error-path matrix incomplete.** `orchestrator.test.ts` lines 252+ show ~15 `it()` blocks. Happy path is there (slice 1, line 253). Error paths: "backend reports error" (line 327), "createTaskContainer throws" (line 370), "worktree allocation failure" (line 388). **Missing:** test the case where `setTaskStatus` or other store mutations fail mid-orchestrator (what's the retry boundary?). Current tests mock the store; a store mutation failure would silently propagate. This is tied to Inngest's `step.run()` boundaries — the test fixtures (line 59, `stepRun = ((_: string, fn: () => Promise<unknown>) => fn())`) are simplified shims that don't model Inngest's re-execution semantics.
  - **Remediation:** Add a test that explicitly stubs `store.getTask()` to throw, call the orchestrator, and assert the error propagates and is catchable by Inngest's retry mechanism. Or use real Inngest in integration tier (currently the integration tests use llmock, not Inngest).

#### Integration gaps

- **Backend stream-json parsing only tested via fixtures.** `claude.test.ts` line 93 defines `FIXTURE`, a hardcoded JSON array. The parser handles `stream_event` → `text_delta`, `system` → `session_id`, `assistant` → deduplicate against deltas, etc. But there are no tests for **malformed JSONL** (truncated JSON, missing `type` field, `session_id` in wrong message kind). And there's no test for **backpressure on stdin** — what happens if the CLI blocks waiting for stdin but the orchestrator closes the input stream early?
  - **Remediation:** Add error-path tests:
    - Malformed JSONL (not valid JSON, missing required fields) → backend throws with clear message.
    - Close stdin early → backend handles gracefully (expect EOF or broken-pipe error).
    - Timeout during plan (no `plan_ready` after N seconds) → orchestrator times out and marks task failed.

- **Worktree allocation doesn't run real git.** The integration tier uses a real Docker container (supervisor.integration.test.ts), but the worktree allocator is mocked in orchestrator.test.ts. The actual `git worktree add` only runs in e2e. No integration test of: "allocate a worktree on the host filesystem, verify the branch name is correct, verify the path exists, verify the branch is checked out".
  - **Remediation:** Add `src/agent/coding/worktree.integration.test.ts` spawning a real git repo and exercising `WorktreeAllocator.allocate()` + idempotent retry.

- **Sysbox userns mapping verified, but cgroup + resource limits not tested.** `supervisor.sysbox.integration.test.ts` line 174 shows `/proc/self/uid_map` is read to prove userns works. But the actual resource limits passed to Docker (cpus, memory, pids) are not validated — there's no test that spawns a workload that tries to exceed the limit and gets killed. This is a prod-only behavior (the limits are read from `ResourceLimits` JSONB).
  - **Remediation:** Add an e2e test that spawns a memory-hog workload inside a task container with a tight memory limit (e.g., 128 MB) and expects OOM kill.

- **Inngest orchestrator event flow not end-to-end.** The integration tier doesn't use real Inngest (it's not in the Docker Compose stack for tests). The step mocking (line 59) simplifies away re-execution semantics. Deferred to broader integration infra work.

#### E2e gaps

- **Production Docker image not tested for coding-specific concerns.** The e2e tier is noted as "future" in PR #76. There's no test proving:
  - `cogmo/devbase:slice1` image exists and publishes to GHCR.
  - Claude Code binary (v2.1.119) boots correctly inside the image.
  - The image's `/etc/claude-code/CLAUDE.md` is correct (managed policy file).
  - Bind-mount paths (worktree, askpass dir) resolve correctly.

- **Sysbox e2e is unit-level.** The `sysbox-e2e` GHA job is defined but the test (`supervisor.sysbox.integration.test.ts`, 2 tests) is lightweight — it only checks `/proc/self/uid_map`. No test of:
  - Task container can spawn sibling containers (e.g., `docker run` inside the container).
  - Sibling containers inherit the sysbox runtime and are isolated.
  - Reaper can clean up sibling containers.

#### Cross-cutting gaps

- **Audit invariants not tested.** No test asserts: "every `insertTask` produces a `coding/task/start` event". Inngest functions that emit these events are not exercised in integration tests. This is a gap that spans the full slice 1→4 range.

- **Double-tap prevention missing.** The Telegram `/repo add` command (line 98) accepts name + path + remoteUrl. If the user taps it twice (network flake causes Telegram to re-send), the second `insertRepo` fails with "UNIQUE name". There's a test (line 99: `it("requires name + local_path + remote_url")`) but no test asserting the handler returns an idempotent error response. This is more a transport-layer concern than coding-specific.

- **Resource cleanup on task failure not tested.** If plan streaming fails partway through (e.g., backend exits with code 1), does `stopTask()` get called? Current orchestrator.test.ts line 327 ("backend reports error") stubs `stopTask` and asserts it was called — good. But there's no integration test of the full path: bad plan stream → orchestrator catches error → calls stopTask → container actually gets stopped on Docker.
  - **Remediation:** Integration-tier test in supervisor context: spawn a container, call the orchestrator with a failing backend, assert the container is stopped via Docker API.

---

### PR #78 — slice 2 (plan approval + execute)

**Shipped:** Plan-approval Telegram inline keyboard (Approve/Revise/Cancel), execute mode (–resume + acceptEdits), streaming progress display (CodingProgressSubscriber), in-process EventEmitter pub/sub (CodingStreamingRegistry), async `delegate_coding` return, new `pending_verify` status.

**Tests added:** 881 unit tests across 30+ files (138 new since slice 1), 1 integration test (end-to-end flow: delegate → plan → approve → execute → pending_verify).

#### Unit gaps

- **Plan keyboard Zod schema missing.** `plan-keyboard.ts` line 71 constructs a `ReplyMarkup` object with inline keyboard buttons. The button data (callback_data) is a Wire code (`o`/`t`/`d`). There's a test for the function (plan-keyboard.test.ts, 63 lines) but no test for the inverse: **parsing a Telegram callback_query with malformed or missing callback_data**. The handler (in telegram/index.ts) receives the query and must validate it.
  - **Remediation:** Add test for invalid callback_data → handler rejects with `invalid_decision` error.

- **EventEmitter concurrency missing.** `streaming-registry.ts` is a simple EventEmitter wrapper (in-process pub/sub). `streaming-registry.test.ts` (188 lines) tests happy-path subscription and emission. **Missing:** 
  - What happens if two subscribers to the same task emit `execute/complete` out of order?
  - What if a subscriber emits while a new subscriber is registering?
  - Test uses `vi.mock('events')` — actual EventEmitter behavior is not exercised (it's a Node builtin, no need to mock).
  - **Remediation:** Remove the mock and use real EventEmitter, then add a concurrency test (e.g., emit 100 events from 5 different pseudo-subscribers and assert all are received by the registry in order).

- **Progress formatting missing edge cases.** `progress-format.test.ts` (125 lines) tests the emoji + status line rendering. **Missing:**
  - Very long goal text (>500 chars) — how does truncation work?
  - Goal with special characters (newlines, emoji, markup) — is it escaped for Telegram?
  - Token count in progress message — tested, but what if `tokenCount` is null? (happens during plan phase before usage is recorded)
  - **Remediation:** Add boundary tests for string length, special characters, null fields.

- **Permission keyboard missing error cases.** `permission-keyboard.test.ts` (101 lines) tests the inline keyboard for tool gate decisions (Once / Task / Deny). **Missing:**
  - What if the callback_data size exceeds Telegram's 64-byte limit?
  - Wire code round-trip (encode → send → decode) with corrupted code?
  - **Remediation:** Add tests for callback_data length validation and wire-code round-trip.

- **Orchestrator status transitions incomplete.** `orchestrator.test.ts` (updated in slice 2) now has ~15+ `it()` blocks. `coding_task_status` has 11 values: `queued`, `planning`, `awaiting_approval`, `executing`, `pending_verify`, `verifying`, `pushed`, `pr_open`, `failed`, `cancelled`. Tests cover: `queued → planning → awaiting_approval` (user trigger) and `queued → planning → executing` (automated trigger). **Missing:**
  - Revise path: `awaiting_approval → queued` (user taps "Revise")
  - Cancel path: `executing → failed` (user taps "Cancel" while running)
  - Status in-flight during `pending_verify` — what if the user checks status before verify finishes?

- **Service.coding.delegate admission control missing.** `service.test.ts` (170 lines) has tests for `delegate_coding` return shape. **Missing:**
  - Test for `maxConcurrentTasks` rejection — if the repo already has N tasks in non-terminal states and the limit is N, the next delegate call should return an admission error.
  - Test for repo not found (deleted between UI and call).
  - **Remediation:** Add tests stubbing `countActiveTasksForRepo` to return the limit, then call `delegate_coding` and expect rejection.

#### Integration gaps

- **Inngest `step.waitForEvent` timeout not tested.** The plan-approval keyboard routes via `step.waitForEvent("coding/task/approval-decision")`. The design says there's a 7-day timeout as an abandoned-task safety net. No integration test of: "emit no decision for 7+ days, expect task marked failed". This requires real Inngest (the simplified `stepRun` mock doesn't model timeouts).
  - **Remediation:** Deferred to broader Inngest integration infra.

- **Telegram progress message editing not tested.** `CodingProgressSubscriber.onTaskEvent()` is supposed to edit the progress message in place (one message per task, updated repeatedly). The unit test (progress-subscriber.test.ts, 197 lines) mocks Telegram and stubs the edit call. No integration test of: "send initial progress message, then edit it 10 times, expect the message ID to stay the same, expect Telegram to receive all edits".
  - **Remediation:** Integration-tier test using real Telegram Test DC (TDesktop) or a Telegram mock that tracks message state.

- **Execute-mode stream-json parser missing error paths.** The execute phase parses the same stream-json as plan, but also expects `tool_call` and `tool_result` events (because the CLI is actually running code). `claude.test.ts` (updated in slice 2, 150 lines added) has fixtures for execute-mode events. **Missing:** test for permission_request events mid-stream (slice 3 feature, but the parser should handle them gracefully in slice 2 by throwing or ignoring).
  - **Remediation:** Add test for unexpected `permission_request` event in execute mode → parser throws "permission gate not implemented".

- **User identity check on approval callback missing.** The plan-approval keyboard callback is routed to a handler that must verify the user tapping Approve is the same user who requested the task. `coding-flow.test.ts` (511 lines) includes an "end-to-end" test, but it doesn't test the case of a **different user tapping Approve**. The handler uses `transportStore.resolveUser(updateFromTelegram.from)` — is that tested?
  - **Remediation:** Add integration test: task created by user A, user B taps Approve, expect `identity_rejected` error.

#### E2e gaps

- **Full orchestration on real Inngest and real Postgres.** The integration test (coding-flow.test.ts) uses PGlite, not real Postgres. No test of:
  - `runCodingTask` durable step boundaries in real Inngest.
  - `runCodingExecute` triggered by `coding/task/plan-approved` event from step.sendEvent.
  - Transaction isolation between concurrent task updates.
  - **Remediation:** Deferred to broader integration infra upgrade (real Postgres in integration tier).

- **Progress message delivery end-to-end.** The design says progress events flow: `coding/task/start` event → `CodingProgressSubscriber` Inngest function → `Telegram.editMessage()`. This is not tested end-to-end.

#### Cross-cutting gaps

- **Audit: every task status transition produces an event.** No test asserts: "setTaskStatus('awaiting_approval') emits `coding/task/plan-finalized`" and the Telegram subscriber receives it. This is an invariant that spans orchestrator + event bus + subscriber.
  - **Remediation:** Integration test: call `setTaskStatus()`, subscribe to the event bus, assert the event arrives.

- **Double-tap prevention on Approve button.** The handler for `/plan approve` (via callback_query) calls `approvePlanIfPending()`. This method should be idempotent: "second tap while the first is still processing should not re-enter the execute handler". The test (tool-gate-wiring.test.ts line 100+) has a comment about idempotency, but doesn't actually test concurrent taps.
  - **Remediation:** Add a test: stubbed `setTaskStatus` that hangs, spawn two concurrent approval callbacks, expect only one execute call.

---

### PR #80 — slice 3 (tool gate + Docker proxy + reaper + cgroup parent)

**Shipped:** Tool-execution permission gating (policy table + Telegram approval keyboard), Docker socket proxy (per-task, policy enforcement at `/containers/create`), reaper cron (TTL + orphan cleanup), cgroup parent assignment (systemd slices).

**Tests added:** 1155 unit tests across 76 files (new: proxy tests, policy tests, cgroup tests, reaper tests, tool-gate wiring).

#### Unit gaps

- **Policy evaluation exhaustive for edge cases.** `policy.test.ts` (276 lines) covers non-Bash tools (allow), Bash read-only commands (allow), test/build/lint (allow), local docker (allow), in-container rm (allow), and some external state changes (git push → prompt). Tests are thorough for **common commands**. **Missing:**
  - IPv6 localhost variations (`::1`, `[::1]`, etc.) — the regex checks for 127.0.0.1 and "localhost", but IPv6 loopback is `::1`.
  - Compound bash operators: `a && b`, `a || b`, `a; b`, pipe chains.
  - Quoted strings with special chars: `curl "https://api.github.com/repos?q=foo&bar"` — does the parser handle URL encoding?
  - Commands that span multiple lines (shell continuation with `\`).
  - **Remediation:** Add tests for IPv6 localhost, compound commands, quoted/escaped strings.

- **Proxy policy mutation missing variants.** `sandbox/proxy/policy.test.ts` (221 lines) tests the policy rules at create time (no privileged, no host network, etc.). **Missing:**
  - What if `HostConfig` is missing entirely? (might not be present for all create payloads)
  - What if `CapAdd` contains both allowed and denied capabilities? (e.g., `["SYS_TIME", "SYS_ADMIN"]` — only SYS_ADMIN is denied, but should the whole request fail?)
  - Label injection idempotency — if labels are already present, does the policy overwrite them or merge?
  - **Remediation:** Add tests for malformed HostConfig, mixed capabilities, label merge behavior.

- **Proxy router HTTP/1.1 upgrade handling not tested.** `proxy/router.test.ts` (119 lines) tests the routing logic (which endpoints are intercepted vs. passed through). But the **upgrade events** (for `/build`, `/session`, etc.) are not tested. The implementation (proxy/index.ts line ~144) pipes raw sockets on upgrade — there's no unit test for this because it requires real socket handling.
  - **Remediation:** Add integration test (below).

- **Reaper TTL + orphan detection incomplete.** `reaper.test.ts` (395 lines) has happy-path tests for TTL expiry and orphan cleanup. **Missing:**
  - Test for the boundary case: container.ttl_expires_at is exactly now() — should it be reaped or not? (should be "expires_at < now()", boundary-inclusive check)
  - Test for cascade delete: parent container reaped → all children should be reaped (the design says "same root_task_id, cascade together").
  - Test for the three-pass order: TTL, then orphan, then stale-DB. What if an orphan is also stale? Does it get handled twice (benign) or does one pass skip it?
  - **Remediation:** Add tests for TTL boundary, cascade behavior, three-pass interaction.

- **Cgroup parent systemd slice naming.** `cgroup-parent.test.ts` (23 lines) is minimal — it just tests the format function. **Missing:**
  - UUID → slice name conversion: strip dashes, append `.slice`, keep the chars valid for systemd (alphanumeric + dash + dot only).
  - Test that invalid UUID strings are rejected.
  - Test for the boundary: systemd slice names have a length limit (~255 chars). A UUID is 36 chars, stripped to 32, plus `.slice` = 37 chars. But the design doc says the slice is `cogmo-task-<dashless-uuid>.slice`. The naming function should validate length.
  - **Remediation:** Add tests for invalid UUIDs, boundary-length names.

- **Tool-gate wiring decision logging incomplete.** `tool-gate-wiring.test.ts` (541 lines) tests the full flow: tool arrives → policy evaluates → if "prompt", send Telegram keyboard → user decides → decision logged. **Missing:**
  - Test for what happens if the decision-log write fails (DB down) — should the tool execution be rolled back? Or should it proceed and log async?
  - Test for double decisions on the same request (user taps Approve then Deny) — the second decision should be ignored (idempotent).
  - Test for timeout on step.waitForEvent — 7-day timeout, after which the task is marked failed.
  - **Remediation:** Add error-path tests for log failure, double decisions, timeout (real Inngest required for last one).

#### Integration gaps

- **Proxy HTTP/1.1 upgrade (buildx) not tested.** The design says `/session` (BuildKit / buildx) uses HTTP/1.1 `Upgrade` to gRPC-over-HTTP/2, and the proxy should pipe raw sockets. No integration test of: "run `docker buildx build` inside a task container, buildx spawns a buildkitd sibling, proxy's upgrade handler is invoked, sibling container is created with Cogmo labels".
  - **Remediation:** Add integration test: task container with `docker buildx` CLI, trigger a build, assert buildkitd sibling appears in Docker API with correct labels.

- **Reaper actual-Docker interaction missing.** `reaper.test.ts` is pure-SQL tests (PGlite, no Docker). The reaper's implementation calls `Docker.removeContainer()` etc. No integration test of: "create real containers via Docker, let TTL expire, run reaper, assert containers are gone from Docker AND the DB row is marked 'reaped'".
  - **Remediation:** Add integration test spawning real containers via Docker, waiting for TTL, running reaper, asserting cleanup.

- **Cgroup parent assignment verified via Docker API.** The supervisor creates containers with `HostConfig.CgroupParent = "cogmo-task-<id>.slice"`. This is passed to Docker and Docker enforces it. No integration test of: "create a container with cgroup parent, run a memory-limit test inside, verify the resource limit is enforced at the slice level (not just the container level)".
  - **Remediation:** Add integration test with resource-limit workload.

- **Permission-request round-trip missing.** When a tool requests permission (via the stream-json permission protocol), the orchestrator sends a Telegram keyboard, waits for a decision, and sends the decision back to the CLI via stdin. The response format is a single character (`o`/`t`/`d` for Once/Task/Deny). No integration test of: "CLI sends permission_request → Cogmo sends Telegram → user taps → Cogmo sends decision → CLI receives decision and continues". The coding-flow test hints at this but doesn't fully exercise it.
  - **Remediation:** Add integration test with mock CLI that sends permission_request JSONL, verify the decision is sent back correctly.

#### E2e gaps

- **Sysbox + proxy socket binding together.** The design says a task container has `/var/run/docker.sock` bind-mounted from a per-task Unix socket path. Inside the container, `docker` CLI calls that socket. The `/session` upgrade happens inside the container, piping to the proxy's socket. No e2e test of: "inside a sysbox task container, run `docker buildx build`, verify buildx can spawn a BuildKit sibling".
  - **Remediation:** Add e2e test (deferred to broader sysbox + buildx coverage).

- **Reaper cron actual-Inngest scheduling.** The reaper is an Inngest scheduled function running every 1 minute. No e2e test of: "start Cogmo, wait 2 minutes, assert the reaper has fired at least twice".
  - **Remediation:** Deferred to broader Inngest e2e infra.

#### Cross-cutting gaps

- **Tool decisions audit invariant.** Every tool permission decision should produce an audit row in `coding_tool_decisions`. The test mentions "audit-only" behavior (line ~479), but there's no cross-module invariant test asserting: "user denies a tool → decision logged → status not marked failed (just skipped that tool) → subsequent tools can still prompt".
  - **Remediation:** Integration test spanning tool-gate + orchestrator + audit table.

- **Concurrency under permission prompts.** What if two tools request permission in parallel? (unlikely in practice since the CLI runs serially, but the design should handle it.) No test of: "two tool requests queued → two Telegram prompts sent → both decisions received → both are recorded in order".
  - **Remediation:** Add concurrency test with staggered tool gates.

---

### PR #86 — slice 4 (verify + push + draft PR)

**Shipped:** Verify orchestrator (runs CLI verify command post-hoc), commit-and-push (SSH-signed commits, git askpass provisioning), draft PR opening (Octokit v22), GitHub identity bundle (PAT + SSH keys), `/repo add` FSM dialog, setup wizard updates.

**Tests added:** 1330 unit tests across 87 files (new: verify.test.ts, commit-push.test.ts, draft-pr.test.ts, verify-orchestrator.test.ts, verify-orchestrator.integration.test.ts, askpass.test.ts, github.test.ts, ssh-keygen.test.ts, wizard updates).

#### Unit gaps

- **GitHub identity serialization round-trip incomplete.** `github.test.ts` (175 lines) tests `GitHubIdentitySchema` parsing, field validation, `serializeGitHubIdentity` round-trip. **Missing:**
  - What if the PAT format is wrong (not `ghp_`...)?
  - What if the SSH public key format is wrong (not `ssh-ed25519 AAAA...`)?
  - What if the SSH private key is corrupted (not valid base64 or wrong armor headers)?
  - Test for `DEFAULT_GITHUB_IDENTITY_NAME` — why is "default" the default and not empty string or nil?
  - **Remediation:** Add format validation tests for PAT prefix, SSH key format, corruption handling.

- **Askpass provisioning missing edge cases.** `askpass.test.ts` (112 lines) tests the helper generation (writes files at the right paths). **Missing:**
  - What if the askpass directory is read-only (permission denied)?
  - What if the task ID is malformed (not a valid UUID)?
  - Cleanup: after stopTask, are files actually deleted? (currently there's a `try/finally` in the code, but the test might not verify it).
  - **Remediation:** Add permission-denied test, cleanup verification.

- **Verify orchestrator state machine incomplete.** `verify-orchestrator.test.ts` (349 lines) tests the orchestrator. Status transitions: `pending_verify → verifying → pushed → pr_open`. **Missing:**
  - `pending_verify → failed` (if verify command fails).
  - `pending_verify → failed` (if commit fails).
  - `pending_verify → failed` (if push fails).
  - `pending_verify → failed` (if PR open fails).
  - Test that the task's failure_reason is set to the error message (not just status=failed).
  - **Remediation:** Add tests for each failure path with assertion on failure_reason.

- **Commit-and-push signing key lookup missing.** `commit-push.test.ts` (243 lines) tests the commit + push orchestration. The implementation calls `secretsStore.getSecret(gitHubIdentitySecretName(identityName))` to get the SSH keys. **Missing:**
  - Test for missing identity (identity_name doesn't exist in secrets).
  - Test for malformed identity JSONB (secret exists but fails Zod parse).
  - **Remediation:** Add error tests for missing/malformed identities.

- **Draft PR Octokit payload incomplete.** `draft-pr.test.ts` (228 lines) tests PR opening. The implementation uses `octokit.rest.pulls.create()`. **Missing:**
  - Test that the PR is opened as a draft (`draft: true` in the payload).
  - Test for auth failure (PAT is invalid or expired).
  - Test for repository not found (repo URL doesn't exist).
  - Test for payload validation (e.g., title too long, body too long).
  - **Remediation:** Add tests for draft flag, auth failure, repo not found, payload validation.

- **SSH keygen round-trip incomplete.** `ssh-keygen.test.ts` (30 lines) is minimal. **Missing:**
  - Test that the generated private + public keys are a valid Ed25519 pair (verify by constructing a signature).
  - Test that the public key can be pasted into GitHub (format check).
  - **Remediation:** Add crypto validation tests.

- **Wizard `/repo add` FSM missing state transitions.** `repo-dialog.ts` (220 lines) implements the dialog. `repo-dialog.test.ts` (209 lines) tests the dialog. **Missing:**
  - Test for invalid input at each step (name with special chars, URL not a valid git URL).
  - Test for the happy path: confirm → auto-clone happens → dialog ends with success.
  - Test for abort at any step (user sends `/cancel` mid-dialog).
  - **Remediation:** Add tests for input validation, auto-clone, abort.

#### Integration gaps

- **Real Gitea + real git push.** The integration test (`verify-orchestrator.integration.test.ts`) uses Gitea containers (excellent!). Happy-path and failure-path are tested. **Missing:**
  - Test for SSH-signed commits verification in Gitea (Gitea's UI shows "Verified" badge if the commit is signed; the test doesn't check this).
  - Test for force-push rejection (if the integration sets up protected main branch).
  - **Remediation:** Add Gitea verification badge check, protected-branch reject test.

- **Octokit integration via real API.** The integration test uses a scoped fetch interceptor to mock Octokit responses (good practice). The mock returns a canned `pulls.create` response. **Missing:**
  - Test for a real Octokit API call against a real GitHub repo (e.g., a test-org repo). This requires a GitHub PAT and a test-org, so it's deferred to manual/CI testing. But the test should at least validate the request payload shape against Octokit's schema.
  - **Remediation:** Add payload-schema validation (not a full API call, but at least a locally-executable check).

- **Askpass environment provisioning end-to-end.** The integration test stubs the sandbox to run `git` directly (without Docker). The askpass files are written to a temp dir and the stub `git` reads them via GIT_ASKPASS env var. This is a good test, but: **Missing:**
  - Test inside a real task container (sysbox) — the askpass dir is bind-mounted at `/.cogmo-askpass/`, Git should find it there.
  - Test for permission denied (askpass dir is read-only) — how does Git respond?
  - **Remediation:** Add sysbox e2e test (deferred).

- **Auto-clone in `/repo add` FSM not tested.** The FSM dialog collects name + remote_url + confirm, then calls `store.insertRepo()` which is stubbed. **Missing:**
  - Integration test: dialog collects input, reaches confirm, orchestrator spawns real `git clone` on the host (or in a temp container), asserts the clone succeeds.
  - **Remediation:** Add integration test with real git clone.

#### E2e gaps

- **Full coding delegation end-to-end on real Inngest + real Postgres.** PR #86 adds the final slice. All slices together should be tested as one flow: delegate → plan → approve → execute → verify → commit → push → draft PR. Currently:
  - Slice 1 e2e: userns isolation (sysbox).
  - Slice 2 e2e: deferred.
  - Slice 3 e2e: deferred.
  - Slice 4 e2e: deferred (marked as "Manual: \\`cogmo setup\\` interactive flow").
  - **Missing:** Full end-to-end test with real Inngest, real Postgres, real Docker, real sysbox, real Claude Code CLI, real Gitea (or real GitHub test repo).
  - **Remediation:** Deferred to Phase 6 P2 (post-PR-#86).

- **Setup wizard end-to-end.** The wizard (`src/setup/wizard.ts`, ~183 lines) interactively prompts for GitHub identity, Telegram token, repos. Tests exist (setup/*.test.ts), but they're unit-level (mocked prompts). **Missing:**
  - e2e test: run the wizard, provide interactive input, assert the config is written correctly.
  - **Remediation:** Add e2e test with fake tty (deferred).

#### Cross-cutting gaps

- **Resource cleanup: askpass directory.** After `stopTask()`, the askpass directory should be cleaned up (avoid credential file accumulation on the host). The code has `try/finally` in `provisionAskpass()` (line ~161), but is there an integration test verifying the cleanup? The test might stubout the cleanup path.
  - **Remediation:** Add integration test: provision askpass, run a task, stop the task, assert the askpass dir is gone.

- **Audit: every PR open produces a Telegram message.** When a draft PR is opened, a message should be sent to the conversation's Telegram channel with the PR URL. No invariant test asserts: "status reached pr_open → PR-open event emitted → Telegram message sent".
  - **Remediation:** Integration test spanning orchestrator + event bus + Telegram adapter.

- **Idempotent retries on verify orchestrator.** The verify orchestrator has `step.run()` boundaries. If the verify step crashes and Inngest retries it, does it re-run the verify command (wasteful) or does it skip straight to commit? The code should be idempotent. No test of: "verify completes, then orchestrator crashes before commit, on restart commit should succeed without re-verifying".
  - **Remediation:** Add idempotent-retry test (requires real Inngest or detailed mocking of step boundaries).

---

## Common Patterns / Repeated Misses

1. **JSONB Zod validation on read missing raw-SQL bypass tests.** Every PR adds JSONB columns (sandbox: labels, resource_limits; coding: devcontainer, worktree_assignment, pr_metadata, resource_usage; secrets: github_identity). **None of the PRs include tests that corrupt JSONB via raw SQL (`UPDATE ... SET col = '{"junk":true}'::jsonb`) and expect the read path to reject.** The pattern exists in skills/store/store.test.ts (line 219), but was not replicated in the new PRs. This is a low-effort, high-value test that catches schema drift bugs.

2. **Stream-json parsing only tested via fixtures, not via malformed input.** Both `ClaudeCodeBackend` (slices 1+2+3) and `CodingExecuteHandle` parse stream-json events. Tests use hardcoded JSONL fixtures. **No tests for truncated JSON, missing required fields, unknown event kinds, or out-of-order events.** Example: what if the plan-ready event arrives before session_id?

3. **Permission/approval keyboard callbacks lacking Telegram API boundary tests.** The plan-approval, permission-decision, and `/repo add` FSM all involve Telegram callback_query handling. **Missing: tests for malformed or missing callback_data, user permissions (identity check), button state races (user taps Approve then network retries the message).**

4. **CLI exit codes and error surfaces not systematized.** The Telegram `/repo` commands (list, add, remove) return text responses. **No exit-code matrix tests asserting consistent error responses (which error type maps to which response text?).** The orchestrator and backend also have exit codes (plan success = 0, failure = non-zero). Incomplete coverage.

5. **Audit invariants (every X produces a Y) untested at module boundaries.** The design emphasizes: "every context call produces an audit row", "every tool decision logged", "every task change emits an event". **These are cross-module invariants, but tests are isolated per module. No integration tests asserting the invariant across orchestrator → event bus → audit table.**

6. **Concurrency and contention not tested.** The design mentions idempotent retries, advisory locks (implicit in DB transactions), and double-tap prevention. **No tests spawn concurrent requests and verify idempotency or lock contention handling.** Example: two users approve the same plan task in parallel — does the second one get rejected or does it succeed idempotently?

7. **Resource cleanup on error incomplete.** When a coding task fails (plan error, execute error, verify error), the sandbox resources should be cleaned up (container stopped, worktree removed, askpass deleted). **Tests check that stopTask() is called (mocked), but no integration test verifies Docker/filesystem actually cleanup.**

8. **Breakpoint-prone dependencies not version-pinned in tests.** Octokit, dockerode, Claude CLI flags, sysbox image tags — all are known to have breaking changes. **No tests verify version expectations.** Example: if octokit changes the API for `pulls.create`, the test would fail, but only at runtime in integration tests. A unit test with a schema validation would catch it earlier.

9. **Regex variant coverage missing.** The policy engine (slice 3) uses regexes to classify commands (`git push`, `npm install`, etc.). **Tests cover common cases, but not all regex variants** (compound operators, quoted strings, IPv6 localhost).

10. **Distributed transaction semantics not modeled.** The orchestrator uses Inngest for durability, but the `stepRun` mock in tests is a direct function call. **No tests exercise Inngest's re-execution semantics (what happens if the first step succeeds, the second step fails mid-stream, and Inngest retries the whole function?).** Deferred to Inngest integration infra work.

---

## Recommended Remediation Slices

Ordered by leverage (bang-for-buck). Each is a PR-sized scope.

### Slice A: JSONB Raw-SQL Validation Tests (low effort, high value) — **shipped 2026-04-30**

**Files:** `src/sandbox/store/store.test.ts`, `src/agent/coding/store/store.test.ts`.

**Work delivered:**
- 8 tests added: `containers.labels`, `containers.resource_limits`, `networks.labels`, `volumes.labels` (sandbox); `coding_repos.devcontainer`, `coding_tasks.worktree_assignment`, `coding_tasks.pr_metadata`, `coding_tasks.resource_usage` (coding).
- `secrets` store has no JSONB columns (`github_identity` is encrypted ciphertext stored as `text`), so no tests required there.
- `DevcontainerSpecSchema` uses `.passthrough()` for forward-compat — corrupting a typed field (`image` as number) is what triggers Zod rejection, not unknown keys.

---

### Slice B: Stream-JSON Error Paths (plan, execute, verify) — **shipped 2026-04-30**

**Files:** `src/agent/coding/claude.test.ts`.

**Work delivered:**
- 10 new tests under `describe("ClaudeCodeBackend stream-json schema robustness")` covering: unknown top-level event types, missing `type` field, malformed system events (no session_id, non-init subtypes), idempotent `session_started` on repeated init events, tool_use blocks missing `id` / `name`, tool_result with non-string content, can_use_tool control_request without `tool_name`, result with no usage block, tool_result-before-tool_use id-as-name fallback, text_delta-before-session_started ordering contract.

**Deferred (out of scope for parser tests):**
- Backpressure / early stdin close — runner-level (`runClaudePlan` / `runClaudeExecute` lifecycle), not parser-level. Best exercised via the integration test tier with a real subprocess.
- Plan-ready timeout — orchestrator concern (Inngest `step.run` boundary). Belongs in `orchestrator.test.ts` or a new integration test, not `claude.test.ts`.

---

### Slice C: Audit Invariants (cross-module integration)

**Files:** New integration test file: `src/agent/coding/audit-invariants.integration.test.ts`.

**Work:**
- Use real PGlite + orchestrator shims to test: task inserted → status changed → event emitted → audit row created.
- Test: tool decision logged → decision appears in audit table with correct scope (once/task/deny).
- Test: context call made → audit row created with method + target + ok/error.
- ~5 tests, ~200 lines of code.

**Effort:** ~6 hours.

**Payoff:** Validates cross-module contracts and design invariants.

---

### Slice D: CLI Exit-Code Matrix (Telegram commands)

**Files:** `src/transport/adapters/telegram/repo-commands.test.ts`, `src/agent/coding/tool.test.ts`.

**Work:**
- For each command surface (Telegram `/repo`, `delegate_coding` tool), enumerate exit codes and test mappings.
- Examples: `repo add` with bad URL → `invalid_input_error` + `[400]`; `repo add` with dupe name → `repo_name_taken` + `[409]`.
- ~15 tests, ~150 lines of code.

**Effort:** ~5 hours.

**Payoff:** Consistent error handling across CLI surfaces; easier debugging.

---

### Slice E: Worktree + Git Integration Tests

**Files:** New: `src/agent/coding/worktree.integration.test.ts`.

**Work:**
- Real git repo, real `git worktree add`.
- Happy path: allocate, verify branch exists and is checked out.
- Idempotent retry: second allocate with same inputs succeeds and doesn't create duplicate.
- Cleanup: remove the worktree after the test.
- ~5 tests, ~200 lines of code.

**Effort:** ~4 hours.

**Payoff:** Validates worktree orchestration against real git; catches TOCTOU bugs.

---

### Slice F: Concurrency + Idempotency Tests

**Files:** Various `*.test.ts` files that mock contention scenarios.

**Work:**
- EventEmitter concurrency: spawn 5 concurrent subscribers, emit 100 events, verify all received.
- Double-tap approval: two concurrent approve callbacks on same task, expect only one execute.
- Concurrent tool decisions: two tools request permission in parallel, both decisions logged in order.
- Reaper concurrent cleanup: two reaper runs simultaneously (via advisory lock in the real impl).
- ~10 tests, ~250 lines of code.

**Effort:** ~8 hours.

**Payoff:** Catches race conditions in production.

---

### Slice G: Resource Cleanup Verification

**Files:** Various integration tests (supervisor, orchestrator, askpass).

**Work:**
- Task fails during plan → container actually stopped (not just `stopTask()` mocked).
- Task fails during execute → worktree removed (not just stubbed).
- Task completes → askpass directory actually deleted (cleanup verification).
- Reaper TTL expires → containers actually deleted from Docker API.
- ~5 tests, ~300 lines of code.

**Effort:** ~6 hours.

**Payoff:** Prevents resource leaks in production.

---

**Total remediation effort:** ~35-40 hours across 7 PRs. Can be parallelized and interleaved with other work. Slices A, B, C are highest leverage (low effort, high confidence gain). Slices D-G are medium-high leverage (good ROI for stability/observability).

