/**
 * Shared fixtures for the setup wizard's step tests (`src/setup/wizard/*.test.ts`).
 *
 * Each test file mocks `@clack/prompts` with `clackPromptsMock()` (from
 * `./clack-prompts-mock.ts`) and drives prompt answers through
 * `mockResolvedValueOnce`; stores are `mock<T>()` stubs behind a sentinel-tx
 * transactor, so assertions can name `FAKE_TX` directly.
 */
import * as p from "@clack/prompts";
import { vi } from "vitest";
import { type MockProxy, mock } from "vitest-mock-extended";
import type { AgentStore } from "../agent/store/index.js";
import type { BootstrapLock } from "../db/bootstrap-lock.js";
import type { Transactor } from "../db/index.js";
import type { SecretsStore } from "../secrets/store/index.js";
import type { TransportStore } from "../transport/store/index.js";

export const FAKE_TX = { __mockTx: true } as never;
export const fakeRunInTx: Transactor = (cb) => cb(FAKE_TX);

/**
 * Drop queued prompt answers: `mockResolvedValueOnce` queues survive
 * `vi.clearAllMocks`, so a test that left one unconsumed would feed the next.
 */
export function resetClackPrompts(): void {
  vi.mocked(p.confirm).mockReset();
  vi.mocked(p.password).mockReset();
  vi.mocked(p.text).mockReset();
  vi.mocked(p.select).mockReset();
  vi.mocked(p.isCancel).mockReset().mockReturnValue(false);
}

export interface WizardTestDeps {
  agentStore: MockProxy<AgentStore>;
  secretsStore: MockProxy<SecretsStore>;
  transportStore: MockProxy<TransportStore>;
  runInTx: Transactor;
  bootstrapLock: BootstrapLock;
}

export function buildWizardDeps(bootstrapLock: BootstrapLock = (fn) => fn()): WizardTestDeps {
  const agentStore = mock<AgentStore>();
  const secretsStore = mock<SecretsStore>();
  const transportStore = mock<TransportStore>();
  secretsStore.putSecret.mockResolvedValue({ id: "s-1" });
  secretsStore.markValidated.mockResolvedValue(undefined);
  secretsStore.getSecretMeta.mockResolvedValue(undefined);
  return { agentStore, secretsStore, transportStore, runInTx: fakeRunInTx, bootstrapLock };
}
