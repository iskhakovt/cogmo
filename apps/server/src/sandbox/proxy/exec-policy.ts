/**
 * The policy for `POST /containers/{id}/exec` (design/sandbox.md → Proxy
 * Design → Exec policy): the body is rebuilt from the allowlisted fields
 * under the same key rules as a create, and a `SYSBOX_` env entry is denied.
 * `Privileged` is not on the allowlist, so it is dropped when `false` and
 * denied otherwise.
 */

import type { Result } from "neverthrow";
import { ExecBodySchema } from "./body-schemas.js";
import { parseBody } from "./key-rules.js";
import type { ProxyRejection } from "./rejection.js";
import { checkSysboxEnv } from "./sysbox-env.js";

/** The body to forward in place of `raw`. */
export function applyExecPolicy(raw: Buffer): Result<Buffer, ProxyRejection> {
  return parseBody(raw, ExecBodySchema)
    .andThen((body) => checkSysboxEnv(body.Env, "Env").map(() => body))
    .map((body) => Buffer.from(JSON.stringify(body), "utf8"));
}
