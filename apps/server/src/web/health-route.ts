import type { ServerResponse } from "node:http";
import { env } from "../env.js";

/**
 * Liveness body shaped after the IETF `application/health+json` draft. 200 +
 * `status: "pass"` whenever the handler runs — the event loop responding IS the
 * liveness signal. No dependency checks: a transient Postgres/Hindsight blip
 * must not loop-restart us under an orchestrator. Readiness lives behind a
 * future `/health/ready` if an LB needs it.
 */
const STARTED_AT = new Date().toISOString();

interface HealthBody {
  status: "pass" | "fail";
  version: string;
  releaseId?: string;
  description: string;
  notes: string[];
}

function healthBody(): HealthBody {
  return {
    status: "pass",
    version: env.VERSION,
    ...(env.GIT_SHA && { releaseId: env.GIT_SHA }),
    description: "cogmo",
    notes: [`node: ${process.version}`, `startedAt: ${STARTED_AT}`],
  };
}

/** Write the health+json liveness response. */
export function writeHealth(res: ServerResponse): void {
  res.writeHead(200, { "Content-Type": "application/health+json" });
  res.end(JSON.stringify(healthBody()));
}
