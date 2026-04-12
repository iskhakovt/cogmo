import { readFileSync } from "node:fs";

/**
 * Resolve an env var with `_FILE` convention for Docker secrets.
 *
 * If `${name}_FILE` is set in the env, reads the file at that path and
 * returns its contents (trimmed). Otherwise returns `envObj[name]`.
 *
 * Standard Docker pattern used by Postgres, MariaDB, Redis, Keycloak.
 * See design/infrastructure.md → Secrets → `_FILE` convention.
 */
export function resolveEnvFile(
  envObj: Record<string, string | undefined>,
  name: string,
): string | undefined {
  const filePath = envObj[`${name}_FILE`];
  if (filePath) {
    return readFileSync(filePath, "utf-8").trim();
  }
  return envObj[name];
}
