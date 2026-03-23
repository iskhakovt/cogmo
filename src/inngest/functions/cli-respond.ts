import type { CliChannel } from "../../channels/cli.js";
import { inngest } from "../client.js";

/**
 * CLI response delivery — thin Inngest function.
 *
 * Listens for message/response events where channel == "cli"
 * and writes the response text to stdout via the CLI adapter.
 *
 * The cliChannel instance is injected at registration time (see index.ts).
 */
export function createCliRespond(cliChannel: CliChannel) {
  return inngest.createFunction(
    {
      id: "cli-respond",
      triggers: [{ event: "message/response", if: 'event.data.channel == "cli"' }],
    },
    async ({ event }) => {
      cliChannel.write(event.data.text);
    },
  );
}
