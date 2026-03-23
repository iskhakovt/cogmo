import type { Channel } from "../../channels/types.js";
import { inngest } from "../client.js";

/**
 * CLI response delivery — thin Inngest function.
 *
 * Listens for message/response events where channel == "cli"
 * and writes the response text to stdout via the channel adapter.
 *
 * The channel instance is injected at registration time (see index.ts).
 */
export function createCliRespond(channel: Channel) {
  return inngest.createFunction(
    {
      id: "cli-respond",
      triggers: [{ event: "message/response", if: 'event.data.channel == "cli"' }],
    },
    async ({ event }) => {
      channel.write(event.data.text);
    },
  );
}
