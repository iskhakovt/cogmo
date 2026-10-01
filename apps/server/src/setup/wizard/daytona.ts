/**
 * Wizard step: the Daytona API key for `SANDBOX_BACKEND=daytona`.
 */

import * as p from "@clack/prompts";
import {
  DAYTONA_API_KEY_SECRET,
  DAYTONA_API_KEY_SECRET_DESCRIPTION,
} from "../../sandbox/daytona/auth.js";
import { type DaytonaProbeOpts, validateDaytonaApiKey } from "../validate.js";
import { cancelGuard, storeSecret, type WizardDeps } from "./step.js";

export async function stepConfigureDaytona(deps: WizardDeps): Promise<void> {
  const existing = await deps.runInTx((tx) =>
    deps.secretsStore.getSecretMeta(tx, DAYTONA_API_KEY_SECRET),
  );

  if (existing) {
    const action = await p.select({
      message: "Daytona API key is already configured. What would you like to do?",
      options: [
        { value: "keep", label: "Keep current key" },
        { value: "replace", label: "Replace (rotate)" },
      ],
    });
    cancelGuard(action);
    if (action === "keep") return;
  } else {
    const proceed = await p.confirm({
      message:
        "Configure Daytona managed sandbox? (optional — required only when SANDBOX_BACKEND=daytona)",
      initialValue: false,
    });
    if (!cancelGuard(proceed)) return;
  }

  p.note(
    [
      "1. Sign in at https://app.daytona.io",
      "2. Open Settings → API Keys → Create",
      "3. Copy the key. Paste below.",
      "",
      "For self-hosted Daytona or a non-default org, set DAYTONA_API_URL /",
      "DAYTONA_ORGANIZATION_ID in the runtime env before continuing — the",
      "wizard validates the key against whichever endpoint those point at.",
    ].join("\n"),
    "Where to get a Daytona API key",
  );

  const rawKey = cancelGuard(
    await p.password({
      message: "Paste your Daytona API key:",
      validate: (v) => {
        if (!v || v.trim().length < 20) return "API key looks too short";
        return undefined;
      },
    }),
  );
  const apiKey = rawKey.trim();

  const probeOpts: DaytonaProbeOpts = {};
  if (process.env.DAYTONA_API_URL) probeOpts.apiUrl = process.env.DAYTONA_API_URL;
  if (process.env.DAYTONA_ORGANIZATION_ID) {
    probeOpts.organizationId = process.env.DAYTONA_ORGANIZATION_ID;
  }

  const s = p.spinner();
  s.start("Validating Daytona API key...");
  const result = await validateDaytonaApiKey(apiKey, probeOpts);
  if (result.valid) {
    s.stop("API key validated.");
  } else {
    s.stop(`Validation failed: ${result.error}`);
    const saveAnyway = await p.confirm({ message: "Save anyway?", initialValue: false });
    if (!cancelGuard(saveAnyway)) return;
  }

  await storeSecret(
    deps,
    {
      name: DAYTONA_API_KEY_SECRET,
      plaintext: apiKey,
      description: DAYTONA_API_KEY_SECRET_DESCRIPTION,
    },
    result.valid,
  );

  p.log.success("Daytona API key stored.");
}
