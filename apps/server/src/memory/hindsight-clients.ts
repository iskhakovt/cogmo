import {
  type Client,
  createClient,
  createConfig,
  HindsightClient,
} from "@vectorize-io/hindsight-client";

export interface HindsightClients {
  /** Class wrapper — retain, bank and memory listing. */
  client: HindsightClient;
  /** Raw generated client — requests whose options the wrapper does not expose. */
  sdkClient: Client;
}

/**
 * Build the class wrapper and the raw sdk client against one server with one
 * credential. `HindsightClient` adds the `Authorization` header from `apiKey`
 * itself; the raw client only sends the headers its config carries, so it
 * gets the same header explicitly — a raw client built without it is a 401
 * on every request.
 */
export function createHindsightClients(baseUrl: string, apiKey: string): HindsightClients {
  return {
    client: new HindsightClient({ baseUrl, apiKey }),
    sdkClient: createClient(
      createConfig({ baseUrl, headers: { Authorization: `Bearer ${apiKey}` } }),
    ),
  };
}
