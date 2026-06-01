import type { AdapterModule } from "../../adapter-module.js";

/**
 * Web channel placeholder adapter. The web UI's outbound delivery (streaming
 * chat responses) lands in Phase 2 as a `StreamingAdapter`; for now the channel
 * exists so `startChannels` matches it (no "unknown channel type" warning) and
 * the oRPC admin layer has a channel to scope its Transport to.
 *
 * The HTTP server drives its OWN web-scoped Transport (built in
 * `bootstrapRuntime`), not the one `startChannels` hands this adapter. `deliver`
 * is never called in Phase 1 — no web `channel_session` rows exist yet, so the
 * DeliveryRouter never fans out here.
 */
const web: AdapterModule = {
  channelType: "web",
  setup: async () => ({
    adapter: {
      async deliver() {
        // No outbound web delivery until Phase 2's streaming adapter.
      },
      async stop() {},
    },
    functions: [],
  }),
};

export default web;
