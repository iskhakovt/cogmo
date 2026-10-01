/**
 * Wizard step: optional tool keys — Tavily web search, validated live, and
 * fal.ai image generation, stored unvalidated.
 */

import * as p from "@clack/prompts";
import { validateTavilyKey } from "../validate.js";
import { cancelGuard, type WizardDeps } from "./step.js";

export async function stepConfigureOptionalTools(deps: WizardDeps): Promise<void> {
  const addTools = await p.confirm({
    message: "Configure optional tools? (Tavily search, fal.ai image generation, etc.)",
    initialValue: false,
  });
  if (!cancelGuard(addTools)) return;

  // Tavily
  const tavilyKey = cancelGuard(await p.password({ message: "Tavily API key (Enter to skip):" }));
  if (tavilyKey) {
    const s = p.spinner();
    s.start("Validating Tavily key...");
    const result = await validateTavilyKey(tavilyKey);
    if (result.valid) {
      await deps.runInTx((tx) =>
        deps.secretsStore.putSecret(tx, {
          name: "tavily_api_key",
          plaintext: tavilyKey,
          description: "Tavily web search",
        }),
      );
      await deps.runInTx((tx) => deps.secretsStore.markValidated(tx, "tavily_api_key"));
      s.stop("Tavily key validated and saved.");
    } else {
      s.stop(`Tavily validation failed: ${result.error}`);
    }
  }

  // fal.ai — image generation. No live validation in v0 (no cheap ping endpoint);
  // errors surface on first use.
  p.note("Get a key at https://fal.ai/dashboard/keys", "fal.ai image generation");
  const falKey = cancelGuard(await p.password({ message: "fal.ai API key (Enter to skip):" }));
  if (falKey) {
    await deps.runInTx((tx) =>
      deps.secretsStore.putSecret(tx, {
        name: "fal_api_key",
        plaintext: falKey,
        description: "fal.ai image generation",
      }),
    );
    p.log.success("fal.ai key saved.");
  }
}
