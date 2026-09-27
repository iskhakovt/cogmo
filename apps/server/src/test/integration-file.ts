/**
 * The integration test file's own database, seeded user and llmock, which
 * `test/integration-setup-per-file.ts` creates before any test module loads.
 */

function fromSetup(name: string): string {
  const value = process.env[name];
  if (value === undefined) {
    throw new Error(`${name} is unset: test/integration-setup-per-file.ts did not run`);
  }
  return value;
}

export function fileDatabaseUrl(): string {
  return fromSetup("DATABASE_URL");
}

/** The user the file's database was seeded with, which `bootstrap()` treats as the owner. */
export function fileDefaultUserId(): string {
  return fromSetup("INTEGRATION_DEFAULT_USER_ID");
}

/** Base URL of the llmock serving the file's cassette. */
export function fileLlmockUrl(): string {
  return fromSetup("INTEGRATION_LLMOCK_URL");
}
