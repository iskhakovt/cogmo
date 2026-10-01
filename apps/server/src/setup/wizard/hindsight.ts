/**
 * Wizard step: a reachability check on the Hindsight memory server. Warns,
 * never blocks.
 */

import * as p from "@clack/prompts";
import { validateHindsight } from "../validate.js";

export async function stepValidateHindsight(): Promise<void> {
  const s = p.spinner();
  s.start("Checking Hindsight memory server...");
  // Use the env value or default
  const url = process.env.HINDSIGHT_URL ?? "http://localhost:8888";
  const result = await validateHindsight(url);
  if (result.valid) {
    s.stop(`Hindsight reachable at ${url}`);
  } else {
    s.stop(`Hindsight not reachable at ${url}: ${result.error}`);
    p.log.warn("Memory features will not work until Hindsight is available.");
  }
}
