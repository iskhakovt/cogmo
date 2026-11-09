# Connectors `[proposed]`

A connector is a process outside cogmo that runs part of cogmo's work somewhere cogmo does not: a Paseo host, a remote machine, another agent runtime. It dials in to cogmo over gRPC, takes jobs, and reports their events and outcomes. cogmo keeps every state machine and every gate; a connector holds only the jobs it runs and the workspaces they use. Where a connector runs, how it is isolated and which credentials it holds are its operator's concern.

| Kind | Contract | Status |
|-|-|-|
| `coding` | the coding jobs below | this doc |
| `channel` | the per-channel `Transport` that [operator-facade.md](operator-facade.md) splits out | after that split; see *Channel connectors* |

## Decisions `[confirmed]`

| Decision | Choice | Rejected |
|-|-|-|
| Wire protocol | gRPC over HTTP/2. Every mainstream language has a production gRPC library, and streaming is part of the protocol. | Connect protocol: its gains are browsers and HTTP/1.1, which no connector needs. oRPC: TypeScript only, other languages through generated OpenAPI. MCP Tasks: built for tools a model calls, and experimental in spec and SDK. REST: generated server stubs and SSE support vary by language. HTTP/3: neither Node nor grpc-go serves gRPC over it. |
| Node library | `@connectrpc/connect-node` + `@bufbuild/protobuf`, speaking gRPC. ESM output, plain generated types, and an in-memory transport (`createRouterTransport`) for tests. | `@grpc/grpc-js`: `@grpc/proto-loader`'s generated types need hand edits, and `ts-proto` brings `long.js`. Connectors see only the `.proto`, so swapping the library touches none of them. |
| Direction | Connectors dial in. One listening port, one auth model, connectors behind NAT work, and channel connectors share the session. | cogmo dialling each connector: a URL per connector, and no path to one cogmo cannot reach. |
| Contract home | `packages/connector-proto/`: `session.proto` and `coding.proto` under `proto/`, `buf.yaml`, `buf.gen.yaml`, and the generated TypeScript under `src/gen/`, committed. Ships in cogmo's release. Package `cogmo.connector.v1`; a breaking change is a `v2` package. | A separate repo with its own versioning, until a connector outside this repo needs it. |
| Contract CI | The `Connector contract` job: `buf lint`, `buf breaking` against `main`, and a check that `buf generate` leaves the tree clean. The generated code is excluded from Biome. | — |
| Credentials | cogmo sends no secret to a connector. A connector pushes with its own git credentials; cogmo opens the PR with the repo's GitHub identity. `PrepareSpec.remote_url` is the repo's remote with any password removed, and with the whole userinfo removed from an http(s) remote, where a token can sit in either position. An SSH login name such as `git@` stays. | A PAT in a job: the identity would leave cogmo's custody for a process cogmo does not run. |
| Process model | One cogmo process serves connectors. The hub is process memory: a second process, such as a rolling deploy's overlap, holds no session or job of the first. | — |
| Runtime dependencies | `@connectrpc/connect` and `@connectrpc/connect-node` 2.3, `@bufbuild/protobuf` 2.16; dev: `@bufbuild/buf` 1.75, `@bufbuild/protoc-gen-es` 2.16. | — |

## Wire contract `[confirmed]`

One server-streaming call carries cogmo's messages to the connector; unary calls carry the connector's side back. Each unary call is acknowledged on its own and is idempotent, so a dropped stream loses nothing the connector already sent, and an error belongs to one call. The server speaks only the gRPC protocol; a Connect or gRPC-Web request gets HTTP 415. It reads messages up to 4 MiB, gRPC's default; a larger one fails `RESOURCE_EXHAUSTED`.

The contract is two files in package `cogmo.connector.v1`, under [`packages/connector-proto/proto/cogmo/connector/v1/`](../packages/connector-proto/proto/cogmo/connector/v1/), which are its source of truth:

- **`session.proto`** holds the service, the session's messages, and the job envelopes (`Job`, `JobEvent`, `JobResult`, `JobError` and its codes), whose oneofs name each kind's payloads.
- **`coding.proto`** holds the coding jobs' payloads: each phase's spec, an agent turn's events, and each phase's result.

Both follow [protobuf.md](../.agents/rules/protobuf.md). From `session.proto`:

```proto
service ConnectorService {
  // The connector's session: cogmo sends jobs and cancels down it while it is open.
  rpc Connect(ConnectRequest) returns (stream ConnectResponse);
  // Connector to cogmo.
  rpc AcceptJob(AcceptJobRequest) returns (AcceptJobResponse);           // idempotent on job_id
  rpc ReportEvents(ReportEventsRequest) returns (ReportEventsResponse);  // idempotent on (job_id, seq)
  rpc FinishJob(FinishJobRequest) returns (FinishJobResponse);           // idempotent on job_id
}

message ConnectResponse {
  oneof message {
    SessionAccepted accepted = 1;     // first message
    Job job = 2;
    CancelJob cancel = 3;
    Heartbeat heartbeat = 4;
  }
}

message Job {
  string job_id = 1;                  // "<task_id>/<phase>/<spec digest>"
  string task_id = 2;
  oneof spec {                        // the specs are in coding.proto
    PrepareSpec prepare = 10;
    AgentTurnSpec plan = 11;
    AgentTurnSpec execute = 12;
    VerifySpec verify = 13;
    PublishSpec publish = 14;
    ReleaseSpec release = 15;
  }
}

message FinishJobRequest {
  string job_id = 1;
  oneof outcome {
    JobResult completed = 2;
    JobError failed = 3;
    Cancelled cancelled = 4;
  }
  optional uint64 last_seq = 5;       // the last event seq it reported; absent if none
}
```

A verify that runs and fails is a `completed` verdict, not a `failed` job.

**The job id is the idempotency key.** cogmo computes `<spec digest>` as the SHA-256 of the spec's proto3 JSON (protobuf-es `toJson`, default options) in RFC 8785 canonical form: `sha256(canonicalJson(…))` from `src/util/canonical-json.ts`. The JSON mapping is specified, so the digest is the same across builds and languages, which no library promises for the binary encoding. A re-sent job therefore keeps its key, and a different spec for the same task and phase gets a new one ([inngest.md](../.agents/rules/inngest.md) → key the request, not the slot). Connectors treat the id as opaque.

**Connector rules**, which the contract suite (*Testing*) checks:

1. **Accept, then start.** The connector persists a job, calls `AcceptJob`, and starts the job only once that call succeeds. It retries a call that fails in transit. When the hub refuses `AcceptJob` with `NOT_FOUND`, because the job has ended or is unknown, the connector drops the job unstarted.
2. **Reattach.** A `Job` whose `job_id` it holds is not new work. It re-sends `FinishJob` if the job has ended, and otherwise keeps reporting from where it was. It may forget a job once cogmo has acknowledged its `FinishJob`; an id it no longer holds is new work.
3. **Conflict.** A `Job` for a task and phase it holds under another running `job_id` fails with `JOB_CONFLICT`.
4. **Restarts.** It keeps persisted jobs across its own restarts and lists them in `held_job_ids`, and lists the tasks whose workspaces it holds in `held_task_ids`. An accepted job it cannot recover is left out, and cogmo reads it as lost.
5. **Not awaited.** It stops a held job that `awaited_job_ids` omits, or whose `AcceptJob` or report comes back `NOT_FOUND`, and keeps that job's workspace until `release`.
6. **Reports.** `seq` rises strictly from 1, and a retried report re-sends the same `seq`. Each request stays under the 4 MiB limit: a larger report is split across calls, and a plan that would not fit is truncated. The connector calls `FinishJob` only once every report for the job has been acknowledged, and passes the last `seq` it sent.
7. **Cancel.** Cancelling is cooperative: it answers with `FinishJob(cancelled)`, or with the job's real outcome if that came first.
8. **Workspaces.** `prepare` adopts an existing workspace for the task on `work_branch`. `release` stops the task's running job first, is idempotent, succeeds for a task it never prepared, and keeps the workspace when the salvage push fails. After a `kept` or failed release, the connector stops listing the task in `held_task_ids`, and the workspace becomes the operator's.
9. **Liveness.** It reconnects when its stream has carried no message for 90 s, which is three missed `Heartbeat`s.

**Auth.** Each call carries `authorization: Bearer <token>`.
- `cogmo connector add <name> --kind coding` mints a 32-byte token, prints it once and stores its SHA-256, as `web_sessions` does. `rotate` replaces the token. `revoke` moves the connector to `revoked`, and refuses while a repo points at it; tasks running on it lose their jobs. `list` shows the connectors.
- Each call checks its token against the hub's cache of active connectors. A 30 s hub timer refreshes the cache from the table, as does a token the cache does not recognise (at most once every 5 s), so a new token works within seconds and a revoke or rotate takes effect, closing the old token's stream, within 30 s. A call that needs a refresh joins the one in flight and waits at most 5 s for it, and an unknown token gets `UNAVAILABLE` while the last refresh failed. Once three refreshes in a row have failed or stalled (90 s since the last good load started), the cache fails closed: every call gets `UNAVAILABLE` and, within 5 s, every open stream closes, so a revoke never outlives it.
- Jobs are keyed on (connector, `job_id`). A call naming another connector's job fails with `PERMISSION_DENIED`, and one naming a job this process does not know fails with `NOT_FOUND`.

**Serving.** cogmo serves plaintext HTTP/2 (h2c) on `CONNECTOR_HOST`:`CONNECTOR_PORT`. When `CONNECTOR_PORT` is unset, no server starts, and boot warns if a repo points at a connector. `CONNECTOR_HOST` defaults to `0.0.0.0`, the container convention `WEB_HOST` follows ([web-ui.md](web-ui.md) → Auth and bind). As there, the boundary is the publish layer: the token crosses h2c in cleartext, so the port is published on host loopback, or reached through a tailnet or a TLS proxy. A bare-metal run with no such layer sets `CONNECTOR_HOST=127.0.0.1`. cogmo sends a `Heartbeat` down the stream every 30 s, which proves the stream alive end to end, since a proxy answers HTTP/2 pings for its own hop. Both sides also send HTTP/2 keepalive pings; cogmo pings every 30 s and closes a connection that has not answered within 20 s. On shutdown the connector server closes after Inngest's drain, so a step that finishes inside the stop grace still receives its `FinishJob`.

When cogmo ends a session, the stream closes with a status that says why: `ABORTED` when a newer session for the connector replaced it, `UNAUTHENTICATED` when its token was rotated or revoked, and `UNAVAILABLE` on shutdown or a stale cache. Closing the server destroys any connection whose streams are still open after 2 s.

## Data model `[proposed]`

| Table / column | Shape | Why |
|-|-|-|
| `connectors` | `id`; `name TEXT NOT NULL`, unique among `active` rows; `kind connector_kind NOT NULL` (`coding`); `status connector_status NOT NULL` (`active`, `revoked`); `token_hash TEXT NOT NULL UNIQUE`; `revoked_at TIMESTAMPTZ`, set exactly when `revoked` (CHECK); `created_at` | Registry and auth. A revoked row stays, so the tasks that ran on it keep their foreign key, and its name can be added again. Whether a connector is connected is process memory, not a column. |
| `coding_repos.connector_id` | `uuid` FK → `connectors.id`, nullable, `ON DELETE RESTRICT` | Null runs the repo's tasks in the built-in sandbox. |
| `coding_tasks.connector_id` | `uuid` FK → `connectors.id`, nullable, `ON DELETE RESTRICT` | Copied from the repo at insert, so repointing a repo never moves a running task. |
| `coding_tasks.session_id` | unchanged column | Holds the session handle from the plan result, which execute passes back. |
| `WorktreeAssignmentSchema` | new variant `{ type: "connector", branch }` | The work branch. The workspace path is the connector's. |
| `chk_coding_tasks_connector_no_container` | `connector_id IS NULL OR container_id IS NULL` | A connector task has no cogmo container. |
| `chk_coding_tasks_connector_assignment` | `worktree_assignment IS NULL OR ((connector_id IS NOT NULL) = (worktree_assignment->>'type' = 'connector'))` | The variant follows where the task runs. |

The module is `src/connector/`: the gRPC server, auth, the session hub, and the `connectors` store. It is a transport edge in the AGENTS.md sense. The coding stages depend on a port in `src/agent/coding/`, which boot wires to the hub:

```ts
interface ConnectorJobs {
  run(
    connectorId: string,
    job: Job,
    handlers: { onEvent(event: JobEvent): void },
  ): Promise<Result<JobOutcome, JobRunError>>;
}
type JobOutcome =
  | { kind: "completed"; result: JobResult }
  | { kind: "failed"; error: JobError }
  | { kind: "cancelled" };
type JobRunError =
  | { kind: "unavailable" }
  | { kind: "lost" }
  | { kind: "timed_out"; cap: "total" | "idle" | "token_budget" };
```

`run` on a `job_id` the hub already holds sends nothing new. An id in flight joins the existing wait, and an id that ended `completed`, `failed` or `cancelled` returns the stored outcome. Only an id that ended `timed_out`, `lost` or `unavailable` is dispatched again.

## Jobs `[proposed]`

The unit is the job, keyed on (connector, `job_id`). The connector owns the job's durable state (rule 4). cogmo's view of the job lives in process memory. It sits inside one step's execution, and the orchestrators run with `retries: 0`, so a process that loses a job also loses the run, and reconcile fails the task. No row would outlive the step that reads it. The durable outcome is the `coding_tasks` row.

```text
dispatched ──► accepted ──► completed | failed | cancelled
    │              ├──────► lost
    │              └──────► timed_out
    ├──────────────────────► unavailable
    └──────────────────────► timed_out
```

| Transition | Trigger | Guard and effect |
|-|-|-|
| → `dispatched` | a stage's step calls `run` | sent on the connector's session, now or when one opens |
| `dispatched → dispatched` | a new session whose `held_job_ids` omit the job | sent again: never persisted, so never started (rule 1) |
| `dispatched → dispatched` | a new session whose `held_job_ids` name the job | not sent again; the connector's retried `AcceptJob` moves it on |
| `dispatched → accepted` | `AcceptJob` | — |
| `dispatched / accepted → accepted` | `ReportEvents` (on `dispatched` it implies acceptance) | events with a new `seq` go to `onEvent`; resets the idle cap |
| `timed_out / lost / unavailable → dispatched` | `run` on the same id | — |
| `dispatched / accepted → completed / failed / cancelled` | `FinishJob` (on `dispatched` it implies acceptance) | the first one wins; a `last_seq` beyond the events received is logged as a gap |
| `dispatched / accepted → failed` | `FinishJob(completed)` whose result case does not match the job's spec | failed with `UNSPECIFIED`; the call gets `INVALID_ARGUMENT` |
| unchanged | `FinishJob` with no outcome | the call gets `INVALID_ARGUMENT` |
| `dispatched → unavailable` | no session accepts it within `CONNECTOR_LEASE_SECONDS` (default 120) of its dispatch | a reconnect does not restart the lease |
| `accepted → lost` | no session holding the job opened within the lease of its session closing, or of an acceptance (`AcceptJob`, or the `ReportEvents` that implies it) that arrived with none open; or a new session's `held_job_ids` omitted it | — |
| `dispatched / accepted → timed_out` | the job kind's total or idle cap | `CancelJob` sent |
| any terminal state | a late `FinishJob` or `ReportEvents` | acknowledged and dropped; the hub keeps the id until a `release` of the task ends `completed` or `failed`, and keeps that release's id, so a retried `FinishJob` or `run` on it gets its outcome |
| any terminal state | a late `AcceptJob` | refused with `NOT_FOUND`; the connector drops the job unstarted (rule 1) |

| Job | Total cap | Idle cap |
|-|-|-|
| `prepare` | 10 min | — |
| `plan`, `execute` | 30 min, the CLI session's cap | 5 min without a report |
| `verify` | the repo's `verify_timeout_seconds` + 60 s | — |
| `publish` | 5 min | — |
| `release` | 10 min | — |

The connector enforces `token_budget` inside the turn. The hub also cancels a turn whose reported input and output tokens together pass it, which resolves `timed_out` with `cap: "token_budget"`. An absent budget is none.

**Session.** A session is one open `Connect` stream. When it closes, its accepted jobs wait out the lease for a new session. A new `Connect` under the same name replaces the old session and closes its stream; its `held_job_ids` decide which jobs carry over.

**Release converges.** A workspace is freed by the first of these:
- the stage that ends the task dispatches `release`;
- when a session opens, the session's held tasks are released if they are terminal;
- every 10 minutes, the session's held tasks are released if they have become terminal.

The session's held tasks are its `held_task_ids` plus the tasks it prepared since. The use case `release-ended-workspaces.ts` in `src/agent/coding/` reads their status, picks the salvage ref and dispatches through `ConnectorJobs`; the hub calls it on connect and on its timer, wired by boot. A held task with no row is released too. One that belongs to another connector is released once it is terminal, and until then only dropped from the held set. The salvage ref is `refs/cogmo-wip/<task-id>` unless the task reached `pr_open`.

A release's result is logged, like the sandbox path's teardown result, and never becomes a `TaskFailure`. The hub updates the held set on every release result, whichever path dispatched it. A `removed_clean` or `salvaged_and_removed` outcome drops the task. A `kept` outcome or a failed release also drops the task from the held set, and the connector stops listing it (rule 8): the workspace is the operator's, as `wip_push_failed_kept` is on the sandbox path, and nothing retries it. A release that resolves with a hub error stays held and is dispatched again at the next connect or sweep.

## Coding on a connector `[proposed]`

The `coding_tasks` state machine and its claims are unchanged, along with the plan gate, the progress stream, `open-pr`, the failure channel and reconcile ([coding-delegation.md](coding-delegation.md)). When `connector_id` is set, the steps that touch the execution environment change. The workspace lives on the connector from `prepare` to `release`, so plan, execute and verify share it.

| Sandbox steps | On a connector |
|-|-|
| the plan run's `allocate-worktree`, `ensure-image-present`, `create-container`, `persist-container-id`, `provision-askpass` and `check-credentials`' Claude token | `prepare-workspace` writes the `connector` assignment (the branch is `cogmo/<idShort>`), then dispatches `prepare`. Only the plan run prepares. |
| the execute and verify runs' `try-resume`, `check-credentials`, `ensure-image-present`, `create-container`, `persist-container-id`, `persist-sandbox-created`, `provision-askpass` | none; they find the workspace by task id |
| `plan-cli` | dispatches `plan`. Text deltas go to the plan stream; the result's plan goes to `persist-plan` and its session handle to `session_id`. |
| `execute-cli`, `persist-usage` | dispatches `execute` with `session_id`; usage comes from the result |
| `commit-and-push-execute-changes`, `checkout-feature-branch`, `fetch-feature-branch`, the execute hand-off's `teardown`, and every `persist-sandbox-deleted` / `persist-sandbox-deleted-after-push-failure` | none |
| `run-verify` | dispatches `verify` |
| `commit-and-push`, `read-head-sha` | `publish-branch` dispatches `publish` to `cogmo/<idShort>`; the head sha comes from the result |
| `open-pr`, `set-pr-metadata`, the transitions and emits | unchanged; verify resolves the GitHub identity for `open-pr` only |
| `teardown-worktree`, `teardown`, `teardown-after-push-failure`, `teardown-cancelled`, `teardown-worktree-cancelled`, wherever the task ends | `release-workspace` dispatches `release` |

Each dispatching step is durable for the reason its sandbox counterpart is: the job is billable or minutes long, and a bare body would repeat it at every later boundary.

**Failure reasons.** `coding_task_failure_reason` gains four values: `connector_unavailable`, `connector_job_lost`, `connector_job_timed_out` and `connector_job_failed`. Every reason ends the task, as every coding failure reason does. `connector_unavailable` and `auth_failed` are pause-class failures, so they belong to the pausing-state follow-up in coding-delegation.md → Failure reasons. The table maps every job's outcome except `release`'s, which is only logged.

| Outcome | Reason | Detail |
|-|-|-|
| `unavailable` | `connector_unavailable` | connector name and lease |
| `lost` | `connector_job_lost` | job id |
| `timed_out` | `connector_job_timed_out` | job kind and cap |
| `AGENT_FAILED` | `cli_exit_error` | the connector's message |
| `NO_PLAN` | `no_plan_produced` | — |
| `BRANCH_CONFLICT`, `PUSH_AUTH_FAILED`, `PUSH_FAILED` | `branch_conflict`, `auth_failed`, `push_failed` | the connector's message |
| `SESSION_LOST`, `WORKSPACE_FAILED`, `JOB_CONFLICT`, `UNSUPPORTED`, `UNSPECIFIED`, and any code this build does not know | `connector_job_failed` | code and message |
| `cancelled` that the hub did not request | `connector_job_failed` | "cancelled by the connector" |
| verify verdict | `verify_failed` / `verify_timed_out` | exit code and output tail |
| verify verdict with no `outcome` | `connector_job_failed` | "verify verdict without an outcome" |

**Failure modes.**

| Crash point or race | State left | Why safe, or the residual |
|-|-|-|
| The stream drops mid-job, and the connector reconnects within the lease | job `accepted` | `held_job_ids` carries it over; reports resume and re-sent `seq`s are dropped (rules 2, 6) |
| The stream drops after cogmo wrote a `Job` and before `AcceptJob` | job `dispatched` | sent again on the next session if the connector had not persisted it; otherwise the connector's retried `AcceptJob` takes it (rule 1) |
| `AcceptJob` reaches cogmo after the job ended (`timed_out`, `unavailable`) | job unchanged | refused with `NOT_FOUND`; the connector drops it unstarted (rule 1) |
| `FinishJob` overtakes an in-flight report | job terminal | a conforming connector cannot do this (rule 6). Otherwise the events past the hub's last `seq` are logged as a gap and the outcome stands. |
| The connector restarts and has lost an accepted job | task `failed`, `connector_job_lost` | rule 4 |
| The connector lost the plan's agent session before execute (a restart or archive while the task waited at the gate) | task `failed`, `connector_job_failed` (`SESSION_LOST`) | the execute job reports it |
| The connector stays away past the lease | task `failed`, `connector_job_lost` or `connector_unavailable` | its workspace is released when it next connects |
| A unary call's response is lost | unchanged | the connector retries; every unary call is idempotent |
| `FinishJob` arrives after the stage gave up (`timed_out`, `lost`) | task `failed` | acknowledged and dropped; the failure exit's `release` stops the job first (rule 8) |
| The in-run `release` and the sweep dispatch the same release | one release | the same `job_id` joins the wait or returns the stored outcome; rule 8 makes a second connector-side release a no-op |
| cogmo stops mid-job, by a crash or a deploy | task `failed`, `run_terminated` | the step dies with the process once the 60 s stop grace runs out, and reconcile fails the task. The restarted hub awaits nothing, so the connector stops the job (rule 5), and the next sweep releases the workspace once reconcile has marked the task `failed`. A CLI session in flight across a deploy ends the same way. |
| A dispatch step re-runs because Inngest lost its result | task `failed`, or job unchanged | with `retries: 0`, the function fails and reconcile fails the task. A redelivery in the same process that re-runs the step gets the stored outcome or joins the wait, so nothing runs twice. **Residual:** a redelivery to another process (a deploy's overlap) finds no record there and dispatches again, and a connector that has forgotten the job (rule 2) runs it twice. The original process normally dies with the run, as the row above describes. |
| Cancel during a job | task `cancelled` | the next sweep, within 10 minutes, releases the workspace, and rule 8 stops the job. The waiting step sees a `cancelled` it did not request, the failure write reads `already_terminal`, and the run reclaims. A job that ends before the sweep runs to its end, as `plan-cli` and `execute-cli` do. **Residual:** the connector works for up to 10 minutes (`todo.md`: `CancelJob` on Cancel) |
| Cancel during `publish` | task `cancelled` | **Residual:** `cogmo/<idShort>` may already be on the remote, as on the sandbox path |
| Cancel at `awaiting_approval` or `pending_verify` | task `cancelled` | the sweep releases the workspace within 10 minutes |
| The connector is revoked mid-job | task `failed`, `connector_job_lost` | the stream closes within 30 s and the token is refused, so the lease runs out |
| The token is rotated mid-job | job `accepted`, if the connector reconnects with the new token within the lease | otherwise as revoked |
| Two connector processes under one name | the newer session | each `Connect` replaces the other's session, and jobs missing from the newer `held_job_ids` are lost. **Residual:** two live processes flap until one stops |
| A call names another connector's job | unchanged | `PERMISSION_DENIED` |

## Paseo connector `[research]`

`connectors/paseo/` is a TypeScript workspace member in cogmo's release, running on the Paseo host. It maps jobs onto `@getpaseo/client`, and runs `verify`, `publish` and the salvage push itself in the worktree, so it gets exit codes and uses the host's git credentials. Its config (cogmo URL and token, Paseo URL and password, a local checkout for each remote, and the Paseo provider for each `AgentTurnSpec.agent`) is the operator's.

| Job | Paseo |
|-|-|
| `prepare` | fetch the mapped checkout, then `workspaces.create({ source: { kind: "worktree", action: "branch-off", ... } })`, or adopt the existing one |
| `plan` | `agents.create({ config: { modeId: "plan" }, idempotencyKey: job_id, labels: { cogmoTaskId } })`; timeline events map onto `JobEvent`s; the agent id is the session handle |
| `execute` | approve the plan request, or switch to `bypassPermissions` and send the execute prompt |
| `verify`, `publish` | the connector's own process, in the worktree |
| `release` | stop the agent, salvage, then archive the agent and the workspace |

Check in a spike before building:
- How a plan-mode turn ends: idle, or a `permission` request whose kind is `plan`.
- How `idempotencyKey` and a caller-chosen `agentId` behave across a client reconnect.
- Whether the public API can switch modes. The SDK handle offers only `sessionMode` on `send`, and `setAgentMode` sits in `./internal/daemon-client`.
- Whether agents survive a daemon restart, which rule 4 depends on.

## Channel connectors `[proposed]`

A channel connector exposes the per-channel `Transport` from [operator-facade.md](operator-facade.md) on the same session, with its messages in `channel.proto`. Inbound messages arrive as a unary `Receive`, idempotent on the platform's message id; deliveries and edits go down the `Connect` stream. Its design follows that doc's split slice.

## Testing `[proposed]`

- **Unit:** the hub and server over `createRouterTransport` with a fake connector. Cover a matrix of the nine rules, the transition table, the caps, lease expiry, a session replaced under one name, revoke and rotate, and the mapping onto `TaskFailure`s.
- **Contract suite:** a TypeScript kit that drives any connector over gRPC through the nine rules. The Paseo connector runs it in CI.
- **Integration:** one coding task end to end against the fake connector, over a real h2c socket bound to port 0.
- **Paseo connector:** against the official Paseo image (a `dev/containers.ts` factory), with the Claude provider's `ANTHROPIC_BASE_URL` pointed at llmock. Whether replay holds across Paseo's provider launch is a spike item.

## Slices `[proposed]`

1. `packages/connector-proto` and its CI checks, with the generated code excluded from Biome. `src/connector/`: the server, auth, hub, store and migration, plus its place in the shutdown order. `cogmo connector add | rotate | revoke | list`, and the unit tier. Docs: the AGENTS.md module table, `store-pattern.md`, and `infrastructure.md` → Shutdown.
2. Coding on a connector: the columns, the CHECKs and the assignment variant; `revoke` refusing while a repo points at the connector; the dispatching steps; the four reasons; the session's held tasks and the release sweep; the integration test. Docs: `coding-delegation.md`'s schema block, step table and failure-reason table.
3. The Paseo spike, then `connectors/paseo` and the contract suite.
4. Channel connectors, after operator-facade slice 3.

## Open questions

- Should the Paseo connector ship as a subcommand of the cogmo image (`cogmo connector run paseo`), or as its own image?
- `AgentTurnSpec.agent` carries `coding_tasks.backend` (`claude`, `codex`). Should a repo be able to name a model too, or is that the connector's config?
