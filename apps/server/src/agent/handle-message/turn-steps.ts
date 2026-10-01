import type { GetStepTools } from "inngest";
import type { inngest } from "../../inngest/client.js";

/**
 * The step tools a `handle-message` phase plans its durable steps with: the
 * handler's own `step`, so each phase's step ids, order and memoized shapes
 * are exactly what the handler would plan inline.
 */
export type TurnSteps = Pick<GetStepTools<typeof inngest>, "run" | "sendEvent">;
