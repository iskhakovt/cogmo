/**
 * The query policy for `POST /images/create` (design/sandbox.md → Proxy
 * Design → The forwarded request). The route both pulls (`fromImage`) and
 * imports (`fromSrc`), and an import writes any tarball under any name, so
 * a task could replace the image the next coding task or a salvage
 * container runs. Only a pull is forwarded: `fromImage` is required, `tag`
 * and `platform` go with it, the import keys are denied, and any other key
 * is dropped. Go reads the first value of a repeated key, and so does this.
 */

import { err, ok, type Result } from "neverthrow";
import { denied, type ProxyRejection } from "./rejection.js";

const IMPORT_KEYS = ["fromSrc", "repo", "message", "changes"] as const;
const FORWARDED_KEYS = ["fromImage", "tag", "platform"] as const;

/** The query to forward in place of `query`. */
export function imageCreateQuery(query: URLSearchParams): Result<URLSearchParams, ProxyRejection> {
  const importKey = IMPORT_KEYS.find((key) => query.has(key));
  if (importKey !== undefined) {
    return err(denied(`The POST /images/create query key ${importKey}`));
  }
  const fromImage = query.get("fromImage");
  if (fromImage === null || fromImage === "") {
    return err(denied("POST /images/create without a fromImage"));
  }
  return ok(
    new URLSearchParams(
      FORWARDED_KEYS.flatMap((key) => {
        const value = query.get(key);
        return value === null || value === "" ? [] : [[key, value]];
      }),
    ),
  );
}
