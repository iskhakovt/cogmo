import { existsSync } from "node:fs";
import type { IncomingMessage, ServerResponse } from "node:http";
import sirv from "sirv";
import { logger } from "../logger.js";

function notFound(res: ServerResponse): void {
  res.writeHead(404, { "Content-Type": "text/plain" });
  res.end("Not Found");
}

/**
 * Serve the built SPA (`apps/web/dist`). `single: true` falls every unknown
 * path back to `index.html` for client-side routing. When the dist is absent
 * (PR1 ships none; a dev backend without an SPA build), every request 404s
 * cleanly instead of sirv throwing at construction.
 */
export function createStaticHandler(
  staticRoot: string,
): (req: IncomingMessage, res: ServerResponse) => void {
  if (!existsSync(staticRoot)) {
    logger.warn({ staticRoot }, "web static root absent — serving 404 for non-API routes");
    return (_req, res) => notFound(res);
  }
  const serve = sirv(staticRoot, { single: true, etag: true });
  return (req, res) => serve(req, res, () => notFound(res));
}
