/**
 * The execute phase's sandbox stage: re-attach to the plan phase's task
 * container if it is still alive, otherwise create a fresh one.
 */

import type { AskpassMaterials } from "../../sandbox/askpass.js";
import {
  isLocalDockerSessionState,
  type SandboxClient,
  type SandboxSessionState,
} from "../../sandbox/index.js";
import type { ResourceLimits } from "../../sandbox/types.js";
import type { GitHubIdentity } from "../../secrets/github.js";
import type { AskpassLease } from "./askpass-lease.js";
import type { CodingRun, TaskStoreDeps } from "./coding-run.js";
import { loadIdentity } from "./git-as-transport.js";
import type { CodingRepoRow, CodingTaskRow } from "./store/index.js";
import {
  checkoutFeatureBranchStep,
  loadSandboxEnv,
  type SandboxAuthDeps,
  taskImage,
  taskSessionSpec,
} from "./task-sandbox.js";
import type { WorktreeAssignment } from "./types.js";

interface ExecuteSandboxDeps extends TaskStoreDeps, SandboxAuthDeps {
  sandbox: SandboxClient;
  devbaseImage: string;
  defaultResourceLimits: ResourceLimits;
  taskTtlMs: number;
}

/**
 * What the git-remote execute run pushes with: identity and askpass
 * together, so "both or neither" is in the type.
 */
export interface ExecutePushCredentials {
  identity: GitHubIdentity;
  askpass: AskpassMaterials;
}

interface ExecuteSandbox {
  state: SandboxSessionState;
  /** Set exactly when the transport is git-remote. */
  push: ExecutePushCredentials | undefined;
}

/**
 * Get-or-create in two checkpoints. `try-resume` returns a live sandbox's
 * state — the plan phase's container is still warm, or the reaper hasn't
 * reached it — and then no clone, checkout or auth resolution is needed.
 * Otherwise `create-container` makes a fresh one, resolving auth inside its
 * body so a resume hit doesn't pay the DB+decrypt and the PAT never becomes
 * a step return value.
 *
 * On git-remote, askpass is provisioned either way: a resume reuses the plan
 * phase's mount, a fresh create mounts it. The identity loads outside any
 * step so the PAT never reaches Inngest's state store — safe without a step
 * only because the function is `retries: 0`; loosen that and the decrypt
 * would replay.
 */
export async function acquireExecuteSandbox(
  run: CodingRun,
  deps: ExecuteSandboxDeps,
  args: {
    task: CodingTaskRow;
    repo: CodingRepoRow;
    assignment: WorktreeAssignment;
    askpass: AskpassLease;
  },
): Promise<ExecuteSandbox> {
  const { sandbox } = deps;
  const resumed = await run.stepRun("try-resume", async () => {
    const existing = await sandbox.tryResumeByTaskId(run.taskId);
    return existing?.state ?? null;
  });

  let push: ExecutePushCredentials | undefined;
  if (sandbox.capabilities.workingTreeTransport === "git-remote") {
    const identity = await loadIdentity({
      runInTx: deps.runInTx,
      secretsStore: deps.secretsStore,
      identityName: args.repo.identityName,
    });
    push = { identity, askpass: await args.askpass.provision(run, identity) };
  }

  if (resumed !== null) return { state: resumed, push };
  const state = await createExecuteSandbox(run, deps, { ...args, push });
  // A resume hit skips these: a prior attempt already ran them, or they
  // don't apply. Each is idempotent on its own (an UPDATE; `checkout -B`).
  if (isLocalDockerSessionState(state)) {
    const containerRowId = state.containerRowId;
    await run.stepRun("persist-container-id", () =>
      deps.runInTx((tx) => deps.store.setTaskContainerId(tx, run.taskId, containerRowId)),
    );
  }
  if (sandbox.capabilities.workingTreeTransport === "git-remote") {
    await checkoutFeatureBranchStep(run, sandbox, state, args.assignment.branch);
  }
  return { state, push };
}

async function createExecuteSandbox(
  run: CodingRun,
  deps: ExecuteSandboxDeps,
  args: {
    task: CodingTaskRow;
    repo: CodingRepoRow;
    assignment: WorktreeAssignment;
    push: ExecutePushCredentials | undefined;
  },
): Promise<SandboxSessionState> {
  const { sandbox, defaultResourceLimits } = deps;
  const image = taskImage(args.repo, deps.devbaseImage);
  // The delegate-gate: the boot-time snapshot warm (Daytona) or the image
  // pull check (Local-Docker), before paying the create cost.
  await run.stepRun("ensure-image-present", async () => {
    await sandbox.ensureImagePresent(image, defaultResourceLimits);
  });
  const state = await run.stepRun("create-container", async () => {
    const auth = await loadSandboxEnv(deps);
    if (auth.isErr()) {
      throw new Error(auth.error.message);
    }
    const session = await sandbox.create(
      taskSessionSpec({
        sandbox,
        task: args.task,
        repo: args.repo,
        assignment: args.assignment,
        identityPat: args.push?.identity.pat,
        askpass: args.push?.askpass,
        image,
        resourceLimits: defaultResourceLimits,
        taskTtlMs: deps.taskTtlMs,
        env: auth.value,
      }),
    );
    return session.state;
  });
  // Raw telemetry: backend, start time, reserved resources. Its own step so
  // the timestamp is checkpointed rather than re-stamped on replay, and a
  // failed write doesn't roll back the sandbox.
  await run.stepRun("persist-sandbox-created", () =>
    deps.runInTx((tx) =>
      deps.store.setTaskResourceUsage(tx, run.taskId, {
        sandbox: {
          backend: sandbox.backendId,
          created_at: new Date().toISOString(),
          provisioned: {
            cpu: defaultResourceLimits.cpus,
            memory_bytes: defaultResourceLimits.memory_bytes,
          },
        },
      }),
    ),
  );
  return state;
}
