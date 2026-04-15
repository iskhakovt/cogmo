/**
 * HTTP health endpoint — liveness only, no dependency checks.
 *
 * Serves `GET /health` with a body shaped after the IETF
 * `application/health+json` draft (expired but still the de-facto
 * reference). Returns 200 with `status: "pass"` whenever the handler
 * runs — the very fact that the event loop responded is the liveness
 * signal.
 *
 * Design notes:
 * - **Liveness only.** Checking DB/Hindsight/Inngest here would mean a
 *   transient Postgres blip restarts us in a loop under Kubernetes.
 *   Dependency-aware readiness lives behind a future `/health/ready`
 *   when an LB or k8s actually needs it.
 * - **Binds to `0.0.0.0:9090`.** Both the host and the port are fixed —
 *   exposure and remapping are deployment concerns (Docker `-p`, k8s
 *   container spec, host firewall). The app just listens. Inside a
 *   container `0.0.0.0` is reachable only via explicit port mapping;
 *   on bare metal the host firewall is the boundary.
 * - **Zero deps.** Node's built-in `http` is enough for one endpoint.
 *   Port to Fastify if the HTTP surface grows beyond this.
 */

import { createServer, type Server } from "node:http";
import { env } from "./env.js";
import { logger } from "./logger.js";

/**
 * Fixed health port. Port mapping is a deployment concern (Docker `-p`,
 * k8s container spec, systemd socket activation) — the app commits to one
 * port and lets deployment map it. 9090 is the conventional "alternative
 * HTTP / ops" port and doesn't collide with Inngest (3000, 8288).
 */
const HEALTH_PORT = 9090;

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

/**
 * Create the health HTTP server without listening. Exported for tests
 * so they can bind to an ephemeral port; production uses `startHealthServer`.
 */
export function createHealthServer(): Server {
  return createServer((req, res) => {
    if (req.method === "GET" && req.url === "/health") {
      res.writeHead(200, { "Content-Type": "application/health+json" });
      res.end(JSON.stringify(healthBody()));
      return;
    }
    res.writeHead(404, { "Content-Type": "text/plain" });
    res.end("Not Found");
  });
}

/**
 * Start the health HTTP server on the fixed port 9090.
 *
 * Returns the node `Server` so the caller can close it on shutdown.
 */
export function startHealthServer(): Promise<Server> {
  const server = createHealthServer();
  return new Promise((resolve) => {
    server.listen(HEALTH_PORT, () => {
      logger.info({ port: HEALTH_PORT, version: env.VERSION }, "health server listening");
      resolve(server);
    });
  });
}
