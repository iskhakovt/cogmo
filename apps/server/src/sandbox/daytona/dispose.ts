/**
 * Release the resources a `Daytona` SDK client holds.
 *
 * The constructor eagerly opens an authenticated socket.io event stream
 * (`new EventDispatcher(...)` + `ensureConnected()`), so merely
 * constructing a client — the runtime backend at boot, a wizard
 * key-validation attempt — puts a live WebSocket and its reconnect
 * timers on the process, whether or not anything ever subscribes.
 *
 * `Daytona` implements `AsyncDisposable`; its `[Symbol.asyncDispose]`
 * shuts the subscription manager down and disconnects the dispatcher.
 * Every construction site pairs with a call here.
 */

import type { Daytona } from "@daytona/sdk";
import { logger } from "../../logger.js";

const log = logger.child({ component: "sandbox.daytona.dispose" });

export async function disposeDaytona(daytona: Daytona): Promise<void> {
  try {
    await daytona[Symbol.asyncDispose]();
  } catch (err) {
    // Disposal is best-effort cleanup on paths that are themselves
    // shutting down or already reporting a prior failure — surfacing
    // this would mask the outcome the caller actually cares about.
    log.warn(
      { err: (err as Error).message },
      "disposing the Daytona SDK client failed — its event-stream socket may stay open",
    );
  }
}
