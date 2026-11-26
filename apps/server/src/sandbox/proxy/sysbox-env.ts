/**
 * Sysbox reads per-container configuration from `SYSBOX_*` variables in the
 * container's OCI env, which the create's `Env`, the image's `ENV` and an
 * exec's `Env` all reach. The name is compared in any case.
 */

import { err, ok, type Result } from "neverthrow";
import { denied, type ProxyRejection } from "./rejection.js";

/**
 * `denied` when an entry of `env` names a `SYSBOX_` variable; `source` names
 * where it came from. The rejection names the variable, never its value.
 */
export function checkSysboxEnv(
  env: ReadonlyArray<string> | null | undefined,
  source: string,
): Result<void, ProxyRejection> {
  const name = (env ?? [])
    .map((e) => e.split("=", 1)[0] ?? "")
    .find((n) => n.toUpperCase().startsWith("SYSBOX_"));
  return name === undefined
    ? ok(undefined)
    : err(denied(`a SYSBOX_ variable in ${source} (${name})`));
}
