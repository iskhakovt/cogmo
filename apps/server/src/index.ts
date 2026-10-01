/**
 * Bootstrap entry. `cogmo serve` and the integration harness call `bootstrap`,
 * which runs the four stages in `src/boot/`: `bootstrapCore` →
 * `bootstrapSandbox` → `bootstrapSkillRunner` → `bootstrapRuntime`. One-shot
 * CLIs (`cogmo skills`, `cogmo migrate-memories`, `cogmo backfill`) call only
 * the stages they need. See `src/main.ts` for the dispatch.
 */

import {
  checkInngestAuth,
  checkS3Bucket,
  independentProbeContext,
  runBootChecks,
} from "./boot/checks.js";
import { bootstrapCore } from "./boot/core.js";
import { verifyHindsight } from "./boot/memory.js";
import { bootstrapRuntime } from "./boot/runtime.js";
import { bootstrapSandbox } from "./boot/sandbox.js";
import { bootstrapSkillRunner } from "./boot/skills.js";
import type { BootstrapOptions, CoreDeps } from "./boot/stages.js";
import { env } from "./env.js";
import { inngest } from "./inngest/index.js";

export { bootstrapCore } from "./boot/core.js";
export { verifyHindsight } from "./boot/memory.js";
export { bootstrapSkillRunner } from "./boot/skills.js";
export { type BootstrapOptions, NO_SANDBOX } from "./boot/stages.js";

/**
 * Probe the dependencies `cogmo serve` needs before it takes traffic. Runs in
 * `bootstrap`, not `bootstrapCore`, so one-shot CLIs neither wait on
 * dependencies they may never touch nor need Inngest keys.
 */
async function verifyDependencies(core: CoreDeps): Promise<void> {
  await runBootChecks(independentProbeContext(), [
    (context) =>
      checkS3Bucket(core.s3Client, { bucket: env.S3_BUCKET, region: env.S3_REGION }, context),
    (context) => verifyHindsight(core, context),
    (context) =>
      checkInngestAuth(
        { fetch, ...context },
        {
          baseUrl: env.INNGEST_BASE_URL,
          dev: env.INNGEST_DEV,
          eventKey: env.INNGEST_EVENT_KEY,
          signingKey: env.INNGEST_SIGNING_KEY,
        },
      ),
  ]);
}

/** Aggregate bootstrap — wires every stage together. */
export async function bootstrap(opts: BootstrapOptions = {}) {
  const core = await bootstrapCore(opts);
  await verifyDependencies(core);
  const sandbox = await bootstrapSandbox(core, opts);
  const { skillRunner } = await bootstrapSkillRunner(core, sandbox, opts);
  const runtime = await bootstrapRuntime(core, sandbox, skillRunner, opts);

  // Spread every stage so any field added to a stage interface flows
  // through to callers without touching the aggregate. `inngest` and
  // `skillRunner` are added explicitly because they're not on any stage
  // shape (the inngest client is a module-level singleton; the skill
  // runner returns from its own factory, unwrapped here).
  return {
    ...core,
    ...sandbox,
    ...runtime,
    inngest,
    skillRunner,
  };
}
