import type { ServerResponse } from "node:http";
import * as R from "remeda";
import { env } from "../env.js";
import type { CheckStatus } from "../liveness/check.js";
import type { CheckResult, LivenessReadings } from "../liveness/registry.js";

/**
 * Liveness body shaped after the IETF `application/health+json` draft
 * (design/liveness.md → Surface). Always 200: `warn` is the draft's healthy
 * with concerns, and a probe acting on the status code would restart cogmo
 * over a fault a restart doesn't fix. `checks` is for a valid web session
 * only, so one URL serves two bodies and neither may be cached.
 */
const STARTED_AT = new Date().toISOString();

interface HealthCheckEntry {
  componentId: string;
  componentType: "component";
  status: CheckStatus;
  reason?: string;
  observedValue?: number;
  observedUnit?: "s";
  time: string;
  output?: string;
}

interface HealthBody {
  status: CheckStatus;
  version: string;
  releaseId?: string;
  description: string;
  notes: string[];
  checks?: Record<string, HealthCheckEntry[]>;
}

function entry({ componentId, reading, time }: CheckResult): HealthCheckEntry {
  return {
    componentId,
    componentType: "component",
    status: reading.status,
    ...(reading.status === "warn" && { reason: reading.reason }),
    ...(reading.observedValue !== null && {
      observedValue: reading.observedValue,
      observedUnit: "s" as const,
    }),
    time: time.toISOString(),
    ...(reading.status === "warn" && { output: reading.output }),
  };
}

function healthBody(liveness: LivenessReadings, withChecks: boolean): HealthBody {
  return {
    status: liveness.status(),
    version: env.VERSION,
    ...(env.GIT_SHA && { releaseId: env.GIT_SHA }),
    description: "cogmo",
    notes: [`node: ${process.version}`, `startedAt: ${STARTED_AT}`],
    ...(withChecks && {
      checks: R.mapValues(
        R.groupBy(liveness.results(), ({ check }) => check),
        (results) => results.map(entry),
      ),
    }),
  };
}

/** Write the health+json response; `withChecks` for a request with a valid web session. */
export function writeHealth(
  res: ServerResponse,
  liveness: LivenessReadings,
  withChecks: boolean,
): void {
  res.writeHead(200, {
    "Content-Type": "application/health+json",
    "Cache-Control": "no-store",
  });
  res.end(JSON.stringify(healthBody(liveness, withChecks)));
}
