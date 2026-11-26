/**
 * Sysbox reads per-container configuration from `SYSBOX_*` variables in the
 * container's OCI env, which the create's `Env`, the image's `ENV` and an
 * exec's `Env` all reach. The name is compared in any case.
 */

import { err, ok, type Result } from "neverthrow";
import { denied, type ProxyRejection } from "./rejection.js";

/** `denied` when an entry of `env` names a `SYSBOX_` variable; `source` names where it came from. */
export function checkSysboxEnv(
  env: ReadonlyArray<string> | null | undefined,
  source: string,
): Result<void, ProxyRejection> {
  const entry = (env ?? []).find((e) =>
    (e.split("=", 1)[0] ?? "").toUpperCase().startsWith("SYSBOX_"),
  );
  return entry === undefined
    ? ok(undefined)
    : err(denied(`a SYSBOX_ variable in ${source} (${entry})`));
}
