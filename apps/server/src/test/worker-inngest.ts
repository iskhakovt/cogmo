/**
 * Base URL of this integration worker's own Inngest dev server, which
 * `test/integration-setup-per-fork.ts` assigns before any test module loads.
 */
export function workerInngestBaseUrl(): string {
  const url = process.env.INNGEST_BASE_URL;
  if (url === undefined) {
    throw new Error("INNGEST_BASE_URL is unset: test/integration-setup-per-fork.ts did not run");
  }
  return url;
}
