/**
 * Cheap reachability probe for the Daytona API. Shared by the runtime
 * `DaytonaSandboxClient.healthCheck` and the setup wizard's
 * `validateDaytonaApiKey` so they can't drift — if the runtime later
 * switches to a dedicated `/ping` endpoint, the wizard validator picks
 * up the same change automatically.
 *
 * Listing one sandbox (page size 1) is the cheapest authenticated call
 * the SDK exposes today, and it works against an empty account.
 */

import type { Daytona } from "@daytonaio/sdk";

export async function daytonaHealthProbe(daytona: Daytona): Promise<void> {
  await daytona.list({}, 1, 1);
}
