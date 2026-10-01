/**
 * The plan phase's sandbox stage: resolve the container's credentials, then
 * create the task container the plan session runs in.
 */

import type { AskpassMaterials } from "../../sandbox/askpass.js";
import {
  isLocalDockerSessionState,
  type SandboxClient,
  type SandboxSessionState,
} from "../../sandbox/index.js";
import type { ResourceLimits } from "../../sandbox/types.js";
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

export interface PlanSandboxDeps extends TaskStoreDeps, SandboxAuthDeps {
  sandbox: SandboxClient;
  devbaseImage: string;
  defaultResourceLimits: ResourceLimits;
  taskTtlMs: number;
}

/**
 * Subscription auth resolves first, outside any step, so a missing secret
 * short-circuits before a container exists for `claude -p` to hang in. On
 * git-remote the GitHub identity follows, for the sandbox's clone, and
 * askpass is mounted on this container: an execute run that resumes it (no
 * `sandbox.create` on that path) re-provisions the same directory.
 *
 * On failure the caller's catch reaps the sandbox by task label whether or
 * not `create` returned, which also covers a managed backend whose
 * provider-side sandbox outlives a thrown create.
 */
export async function preparePlanSandbox(
  run: CodingRun,
  deps: PlanSandboxDeps,
  args: {
    task: CodingTaskRow;
    repo: CodingRepoRow;
    assignment: WorktreeAssignment;
    askpass: AskpassLease;
  },
): Promise<SandboxSessionState> {
  const { sandbox } = deps;
  const { task, repo, assignment } = args;
  const auth = await loadSandboxEnv(deps);
  if (auth.isErr()) {
    throw new Error(auth.error.message);
  }
  const env = auth.value;

  let identityPat: string | undefined;
  let askpassMaterials: AskpassMaterials | undefined;
  if (sandbox.capabilities.workingTreeTransport === "git-remote") {
    const identity = await loadIdentity({
      runInTx: deps.runInTx,
      secretsStore: deps.secretsStore,
      identityName: repo.identityName,
    });
    identityPat = identity.pat;
    askpassMaterials = await args.askpass.provision(run, identity);
  }

  const image = taskImage(repo, deps.devbaseImage);
  // The delegate-gate: on Daytona this resolves once the named snapshot is
  // ACTIVE (boot fires the same call without waiting, so a steady-state task
  // finds it resolved); on Local-Docker it is the cheap pull check. Limits
  // ride along so a warm first triggered here bakes them in.
  await run.stepRun("ensure-image-present", async () => {
    await sandbox.ensureImagePresent(image, deps.defaultResourceLimits);
  });
  const state = await run.stepRun("create-container", async () => {
    const session = await sandbox.create(
      taskSessionSpec({
        sandbox,
        task,
        repo,
        assignment,
        identityPat,
        askpass: askpassMaterials,
        image,
        resourceLimits: deps.defaultResourceLimits,
        taskTtlMs: deps.taskTtlMs,
        env,
      }),
    );
    return session.state;
  });

  // Its own step, so a failed DB write doesn't lose the container. Local-
  // Docker only: `containers` is its FK target, and managed backends track
  // lineage through the sandbox's task-id label instead.
  if (isLocalDockerSessionState(state)) {
    const containerRowId = state.containerRowId;
    await run.stepRun("persist-container-id", () =>
      deps.runInTx((tx) => deps.store.setTaskContainerId(tx, run.taskId, containerRowId)),
    );
  }
  if (sandbox.capabilities.workingTreeTransport === "git-remote") {
    await checkoutFeatureBranchStep(run, sandbox, state, assignment.branch);
  }
  return state;
}
