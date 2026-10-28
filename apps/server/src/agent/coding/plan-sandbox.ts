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
  loadSandboxEnvOrThrow,
  type SandboxAuthDeps,
  taskImage,
  taskSessionSpec,
} from "./task-sandbox.js";
import type { WorktreeAssignment } from "./types.js";

interface PlanSandboxDeps extends TaskStoreDeps, SandboxAuthDeps {
  sandbox: SandboxClient;
  devbaseImage: string;
  defaultResourceLimits: ResourceLimits;
  taskTtlMs: number;
}

/**
 * The run's `check-credentials` step has already found the Claude OAuth token
 * and, on git-remote, the GitHub identity. Each loads inside the step body
 * that uses it — the token and the clone's PAT in `create-container`, the
 * identity for askpass in `provision-askpass` — so neither becomes a step
 * return value and the bare body depends only on the memoized verdict.
 * Askpass is mounted on this container: an execute run that resumes it (no
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

  // Called only inside the step bodies that consume it.
  const identity =
    sandbox.capabilities.workingTreeTransport === "git-remote"
      ? () =>
          loadIdentity({
            runInTx: deps.runInTx,
            secretsStore: deps.secretsStore,
            identityName: repo.identityName,
          })
      : undefined;
  const askpassMaterials: AskpassMaterials | undefined = identity
    ? await args.askpass.provision(run, identity)
    : undefined;

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
        identityPat: identity ? (await identity()).pat : undefined,
        askpass: askpassMaterials,
        image,
        resourceLimits: deps.defaultResourceLimits,
        taskTtlMs: deps.taskTtlMs,
        env: await loadSandboxEnvOrThrow(deps),
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
