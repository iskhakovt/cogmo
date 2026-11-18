import { err, type Result } from "neverthrow";
import { match } from "ts-pattern";
import type { ResourceLimits } from "../../sandbox/index.js";
import { DEFAULT_DEPENDENCY_SESSION_LIMITS, type LockfileSnapshot } from "../deps.js";
import { SchemaImportReplySchema } from "../protocol.js";
import {
  type ImportedSchemas,
  type SchemaImportError,
  schemaImportResult,
} from "../schema-import.js";
import { execForReply, type SkillsSessionHost, withOneShotSession } from "./one-shot-session.js";

/** The container tier's schema import at register (design/skills.md → Contracts). */
export interface ContainerSchemaImporter {
  /**
   * Import `body` and read its models' JSON Schemas, in a session created
   * with no network. With a lockfile, the session mounts the shared venv
   * volume and activates the venv register's install session populated
   * there. The session does not outlive `signal`.
   */
  importSchemas(params: {
    body: string;
    lockfile: LockfileSnapshot | null;
    /** The skill's own limits, over the dependency sessions' defaults. */
    resourceLimits: Partial<ResourceLimits>;
    /** The import's budget: the run's wall clock. */
    timeoutMs: number;
    signal?: AbortSignal;
  }): Promise<Result<ImportedSchemas, SchemaImportError>>;
}

export interface SandboxSchemaImporterOptions extends SkillsSessionHost {
  /**
   * The shared venv volume, which carries register's install session's venv
   * to the import session; a lockfile without it is a caller bug.
   */
  depsCacheVolumeName: string | undefined;
}

/** The {@link ContainerSchemaImporter} over sandbox sessions of the skills image. */
export function makeSandboxSchemaImporter(
  opts: SandboxSchemaImporterOptions,
): ContainerSchemaImporter {
  return {
    async importSchemas(params) {
      const { lockfile, signal } = params;
      if (lockfile !== null && opts.depsCacheVolumeName === undefined) {
        throw new Error("schema import: a lockfile needs the shared venv volume");
      }
      const unavailable = (message: string): SchemaImportError => ({
        kind: "unavailable",
        message,
      });
      const reply = await withOneShotSession(
        opts,
        {
          name: "schema-import",
          network: "none",
          depsCacheVolume:
            lockfile === null || opts.depsCacheVolumeName === undefined
              ? undefined
              : { volumeName: opts.depsCacheVolumeName },
          resourceLimits: { ...DEFAULT_DEPENDENCY_SESSION_LIMITS, ...params.resourceLimits },
          budgetMs: params.timeoutMs,
        },
        signal,
        unavailable,
        async (session) => {
          const imported = await execForReply(session, {
            argv: [
              "python3",
              "-I",
              "-m",
              "cogmo_skills_runtime.schema",
              ...(lockfile === null ? [] : [lockfile.hash]),
            ],
            stdin: params.body,
            schema: SchemaImportReplySchema,
            timeoutMs: params.timeoutMs,
            signal,
            label: "the import",
          });
          // A reply past its cap is the skill's: module code printed it.
          return imported.mapErr((e) =>
            match(e)
              .returnType<SchemaImportError>()
              .with({ kind: "overflow" }, ({ message }) => ({ kind: "refused", message }))
              .with({ kind: "failed" }, ({ message }) => unavailable(message))
              .exhaustive(),
          );
        },
      );
      if (reply.isErr()) return err(reply.error);
      return schemaImportResult(reply.value, (error) => `the import did not start: ${error}`);
    },
  };
}
