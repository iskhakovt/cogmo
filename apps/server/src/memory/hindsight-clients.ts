import {
  type Client,
  createClient,
  createConfig,
  HindsightClient,
} from "@vectorize-io/hindsight-client";
import { describeError } from "../util/describe-error.js";

export interface HindsightClients {
  /** Class wrapper — retain, bank and memory listing. */
  client: HindsightClient;
  /** Raw generated client — requests whose options the wrapper does not expose. */
  sdkClient: Client;
}

/**
 * Readable text for a raw sdk call's `error`: an `Error` (a failed or aborted
 * fetch) via `describeError`, a server error body as JSON.
 */
export function describeHindsightError(error: unknown): string {
  return error instanceof Error ? describeError(error) : JSON.stringify(error);
}

/**
 * Build the class wrapper and the raw sdk client for one server and key. The
 * raw client sends only the headers in its config, so it gets the bearer
 * header explicitly.
 */
export function createHindsightClients(baseUrl: string, apiKey: string): HindsightClients {
  return {
    client: new HindsightClient({ baseUrl, apiKey }),
    sdkClient: createClient(
      createConfig({ baseUrl, headers: { Authorization: `Bearer ${apiKey}` } }),
    ),
  };
}
