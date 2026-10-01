/**
 * What every wizard step shares: the stores it writes through and the cancel
 * handling around each prompt.
 */

import * as p from "@clack/prompts";
import type { AgentStore } from "../../agent/store/index.js";
import type { BootstrapLock } from "../../db/bootstrap-lock.js";
import type { Transactor } from "../../db/transactor.js";
import type { SecretsStore } from "../../secrets/store/index.js";
import type { TransportStore } from "../../transport/store/index.js";

/** Thrown when the user cancels a prompt. Caught by runSetup to exit cleanly. */
export class WizardCancelled extends Error {
  constructor() {
    super("Setup cancelled by user");
    this.name = "WizardCancelled";
  }
}

export function cancelGuard<T>(value: T | typeof p.CANCEL_SYMBOL): T {
  if (p.isCancel(value)) throw new WizardCancelled();
  return value;
}

export interface WizardDeps {
  runInTx: Transactor;
  agentStore: AgentStore;
  transportStore: TransportStore;
  secretsStore: SecretsStore;
  bootstrapLock: BootstrapLock;
}

/**
 * Store a credential a step collected, marked validated when its live probe
 * passed. One transaction, so a stored secret's validation mark is never lost.
 */
export async function storeSecret(
  deps: Pick<WizardDeps, "runInTx" | "secretsStore">,
  secret: { name: string; plaintext: string; description: string },
  validated: boolean,
): Promise<void> {
  await deps.runInTx(async (tx) => {
    await deps.secretsStore.putSecret(tx, secret);
    if (validated) await deps.secretsStore.markValidated(tx, secret.name);
  });
}
