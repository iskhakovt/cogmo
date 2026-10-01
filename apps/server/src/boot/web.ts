/**
 * The web UI server `cogmo serve` starts once the bootstrap finishes.
 */

import { env } from "../env.js";
import { verifyWebLoginToken } from "../web/auth/login-token.js";
import { startWebServer, type WebServer } from "../web/server.js";
import type { CoreDeps, RuntimeDeps } from "./stages.js";

export function startWebUi(
  boot: Pick<CoreDeps, "runInTx" | "webSessionStore" | "webLoginToken" | "user"> &
    Pick<RuntimeDeps, "webTransport" | "webStreamRegistry">,
): Promise<WebServer> {
  return startWebServer({
    webTransport: boot.webTransport,
    webSessionStore: boot.webSessionStore,
    webStreamRegistry: boot.webStreamRegistry,
    runInTx: boot.runInTx,
    verifyLoginToken: (candidate) => verifyWebLoginToken(candidate, boot.webLoginToken),
    ownerUserId: boot.user.id,
    sessionTtlDays: env.WEB_SESSION_TTL_DAYS,
    cookieSecure: !env.WEB_INSECURE_COOKIES,
    staticRoot: env.WEB_STATIC_ROOT,
    webDevAllowOrigin: env.WEB_DEV_ALLOW_ORIGIN ?? null,
    host: env.WEB_HOST,
    port: env.WEB_PORT,
  });
}
