import { err, ok, type Result } from "neverthrow";
import { match } from "ts-pattern";
import type { DepsCacheVolumeSpec, SandboxSession } from "../../sandbox/index.js";
import type { CpythonCheckError, CpythonCheckOutcome, CpythonChecks } from "../cpython-checks.js";
import {
  DEFAULT_DEPENDENCY_SESSION_LIMITS,
  ensureVenvPopulated,
  INSTALL_TIMEOUT_MS,
  isLockfileContentRefusal,
  type LockfileSnapshot,
} from "../deps.js";
import { CheckReplySchema, type CheckRequest } from "../protocol.js";
import { execForReply, type SkillsSessionHost, withOneShotSession } from "./one-shot-session.js";

/** The tools' budget in a check session. */
const CHECK_TIMEOUT_MS = 120_000;

export interface SandboxCpythonChecksOptions extends SkillsSessionHost {
  /**
   * The shared venv volume, which carries the install session's venv to the
   * check session; without it, a check session populates the venv on its own
   * disk.
   */
  depsCacheVolumeName: string | undefined;
}

/**
 * Register's {@link CpythonChecks} over sessions of the skills image
 * (design/skills.md → Register-time CPython checks → Which session). With
 * dependencies and the shared volume, an install session with network
 * populates the lockfile's venv there, and the check session mounts it.
 * Without the volume, the check session populates the venv on its own disk
 * first, so it has network. Otherwise the check session has no network where
 * the backend allows it. Each session is deleted whatever the outcome, and
 * none outlives the register's signal. Every session's bounds are Cogmo's,
 * never the skill's.
 */
export function makeSandboxCpythonChecks(opts: SandboxCpythonChecksOptions): CpythonChecks {
  return {
    async check({ body, dependencies, lockfile, signal }) {
      const depsCacheVolume: DepsCacheVolumeSpec | undefined =
        lockfile !== null && opts.depsCacheVolumeName !== undefined
          ? { volumeName: opts.depsCacheVolumeName }
          : undefined;
      if (lockfile !== null && depsCacheVolume !== undefined) {
        const installed = await withOneShotSession(
          opts,
          {
            name: "install",
            network: "bridge",
            depsCacheVolume,
            resourceLimits: DEFAULT_DEPENDENCY_SESSION_LIMITS,
            budgetMs: INSTALL_TIMEOUT_MS,
          },
          signal,
          unavailable,
          (session, taskId) => populate(session, lockfile, taskId, signal),
        );
        if (installed.isErr()) return err(installed.error);
      }
      const populating = lockfile !== null && depsCacheVolume === undefined ? lockfile : null;
      const request: CheckRequest = {
        body,
        dependencies: [...dependencies],
        lockfileHash: lockfile?.hash ?? null,
      };
      return withOneShotSession(
        opts,
        {
          name: "check",
          network:
            populating === null && opts.sandbox.capabilities.noNetworkSessions ? "none" : "bridge",
          depsCacheVolume,
          resourceLimits: DEFAULT_DEPENDENCY_SESSION_LIMITS,
          budgetMs: CHECK_TIMEOUT_MS + (populating === null ? 0 : INSTALL_TIMEOUT_MS),
        },
        signal,
        unavailable,
        async (session, taskId) => {
          if (populating !== null) {
            const populated = await populate(session, populating, taskId, signal);
            if (populated.isErr()) return err(populated.error);
          }
          return runChecks(session, request, signal);
        },
      );
    },
  };
}

function unavailable(detail: string): CpythonCheckError {
  return { kind: "unavailable", detail };
}

/**
 * Populate the lockfile's venv. A sync uv refuses for the lockfile's content
 * is a verdict on the lockfile; any other failure may clear on a retry.
 */
async function populate(
  session: SandboxSession,
  lockfile: LockfileSnapshot,
  taskId: string,
  signal: AbortSignal | undefined,
): Promise<Result<void, CpythonCheckError>> {
  const populated = await ensureVenvPopulated({
    session,
    lockfileHash: lockfile.hash,
    lockfileContents: lockfile.contents,
    workerId: taskId,
    timeoutMs: INSTALL_TIMEOUT_MS,
    ...(signal && { signal }),
  });
  return populated.mapErr((e) =>
    match(e)
      .returnType<CpythonCheckError>()
      .with({ kind: "populate_failed" }, ({ message }) =>
        isLockfileContentRefusal(message)
          ? { kind: "lockfile_invalid", detail: message }
          : unavailable(`the skill's dependencies did not install: ${message}`),
      )
      .with({ kind: "transport_failed" }, ({ message }) =>
        unavailable(`the install did not finish: ${message}`),
      )
      .exhaustive(),
  );
}

/** Run `cogmo_skills_runtime.check` on the request and read its one reply. */
async function runChecks(
  session: SandboxSession,
  request: CheckRequest,
  signal: AbortSignal | undefined,
): Promise<Result<CpythonCheckOutcome, CpythonCheckError>> {
  const reply = await execForReply(session, {
    argv: ["python3", "-I", "-m", "cogmo_skills_runtime.check"],
    stdin: JSON.stringify(request),
    schema: CheckReplySchema,
    timeoutMs: CHECK_TIMEOUT_MS,
    signal,
    label: "the check runner",
  });
  if (reply.isErr()) return err(unavailable(reply.error.message));
  return match(reply.value)
    .returnType<Result<CpythonCheckOutcome, CpythonCheckError>>()
    .with({ type: "check_findings" }, ({ findings, suppressions, toolchainVersion }) =>
      ok({ findings, suppressions, toolchainVersion }),
    )
    .with({ type: "fatal" }, ({ error }) => err(unavailable(`the checks could not run: ${error}`)))
    .exhaustive();
}
