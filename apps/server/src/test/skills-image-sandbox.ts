import { hostname } from "node:os";
import Docker from "dockerode";
import { LocalDockerSandboxClient } from "../sandbox/index.js";
import type { SandboxRuntime } from "../sandbox/runtime.js";
import { DrizzleSandboxStore } from "../sandbox/store/index.js";
import { LABEL_INSTANCE, LABEL_MANAGED } from "../sandbox/supervisor.js";
import { createTestDatabase } from "./pglite.js";

/**
 * The skills image this commit builds, as `VERSION=test docker buildx bake
 * --load skills` tags it: what the sysbox-e2e workflow loads before its tests.
 */
export const SKILLS_TEST_IMAGE = "ghcr.io/iskhakovt/cogmo-skills:test";

/**
 * The runtime `SANDBOX_RUNTIME` names, under which the skills image's
 * integration files run: `sysbox` in the sysbox-e2e workflow, `runc` on a
 * rootless dev host. Undefined when it is unset, as in the main integration
 * job, which builds no skills image, so those files skip.
 */
export function skillsImageRuntime(): SandboxRuntime | undefined {
  const value = process.env.SANDBOX_RUNTIME;
  return value === "sysbox" || value === "runc" ? value : undefined;
}

/** A Local-Docker client on the skills image, and what stops it. */
export interface SkillsImageSandbox {
  sandbox: LocalDockerSandboxClient;
  docker: Docker;
  /** Shut the client down, remove any container it left, and close its database. */
  stop(): Promise<void>;
}

/**
 * A Local-Docker client as `cogmo skills` builds it, with no socket proxy, so
 * no session mounts a Docker socket; its instance row in a PGlite database of
 * its own. Throws when the skills image is not loaded.
 */
export async function startSkillsImageSandbox(
  runtime: SandboxRuntime,
): Promise<SkillsImageSandbox> {
  const docker = new Docker();
  try {
    await docker.getImage(SKILLS_TEST_IMAGE).inspect();
  } catch {
    throw new Error(
      `${SKILLS_TEST_IMAGE} not loaded into local Docker. Run \`VERSION=test docker buildx bake --load skills\` first.`,
    );
  }
  const { tx, close } = await createTestDatabase();
  const store = new DrizzleSandboxStore();
  const instance = await tx((trx) =>
    store.insertInstance(trx, { host: hostname(), pid: process.pid }),
  );
  const sandbox = await LocalDockerSandboxClient.create({
    docker,
    store,
    runInTx: tx,
    runtime,
    instanceId: instance.id,
  });
  return {
    sandbox,
    docker,
    async stop() {
      await sandbox.shutdown();
      const leftover = await docker.listContainers({
        all: true,
        filters: { label: [`${LABEL_MANAGED}=true`, `${LABEL_INSTANCE}=${instance.id}`] },
      });
      for (const c of leftover) {
        await docker
          .getContainer(c.Id)
          .remove({ force: true })
          .catch(() => {});
      }
      await close();
    },
  };
}
