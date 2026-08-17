/**
 * Cheap reachability probe for the Daytona API. Shared by the runtime
 * `DaytonaSandboxClient.healthCheck` and the setup wizard's
 * `validateDaytonaApiKey` so they can't drift — if the runtime later
 * switches to a dedicated `/ping` endpoint, the wizard validator picks
 * up the same change automatically.
 *
 * Listing sandboxes is the cheapest authenticated call the SDK exposes
 * today, and it works against an empty account.
 */

import type { Daytona } from "@daytona/sdk";

/**
 * A label key no Cogmo sandbox carries (we stamp `cogmo.task`,
 * `cogmo.role` and `cogmo.instance`), so the filtered page comes back
 * empty.
 *
 * That empty page is the point. `list()` hydrates every item it yields
 * with a second `getToolboxProxyUrl` request whenever the list DTO's
 * `toolboxProxyUrl` is missing, so a probe that can match a row is two
 * requests against two services. Both callers read whatever the probe
 * throws as a verdict on the credential — a 404 on a since-reaped
 * sandbox or a proxy-service outage would surface as "your API key was
 * rejected" and fail the boot health check for a subsystem the probe
 * never meant to cover. Matching nothing keeps it to exactly one request
 * against the endpoint it means to test.
 */
const UNMATCHABLE_LABEL_KEY = "cogmo.health-probe";

export async function daytonaHealthProbe(daytona: Daytona): Promise<void> {
  // `list` returns a lazy async iterator that pages on demand, so the
  // first `next()` is what issues the authenticated request. It comes
  // back with no items and no cursor, so the generator finishes there —
  // no hydration, no second page.
  await daytona.list({ limit: 1, labels: { [UNMATCHABLE_LABEL_KEY]: "never-set" } }).next();
}
