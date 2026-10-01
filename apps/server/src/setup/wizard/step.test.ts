import * as p from "@clack/prompts";
import { describe, expect, it, vi } from "vitest";
import type { Transactor } from "../../db/index.js";
import { buildWizardDeps, FAKE_TX } from "../../test/wizard.js";
import { cancelGuard, storeSecret, WizardCancelled } from "./step.js";

vi.mock("@clack/prompts", async () =>
  (await import("../../test/clack-prompts-mock.js")).clackPromptsMock(),
);

const SECRET = { name: "tavily_api_key", plaintext: "tvly-key", description: "Tavily web search" };

describe("storeSecret", () => {
  it("stores and marks a validated secret in one transaction", async () => {
    const deps = buildWizardDeps();
    let transactions = 0;
    const runInTx: Transactor = (cb) => {
      transactions += 1;
      return deps.runInTx(cb);
    };

    await storeSecret({ ...deps, runInTx }, SECRET, true);

    expect(transactions).toBe(1);
    expect(deps.secretsStore.putSecret).toHaveBeenCalledWith(FAKE_TX, SECRET);
    expect(deps.secretsStore.markValidated).toHaveBeenCalledWith(FAKE_TX, "tavily_api_key");
  });

  it("leaves an unvalidated secret unmarked", async () => {
    const deps = buildWizardDeps();

    await storeSecret(deps, SECRET, false);

    expect(deps.secretsStore.putSecret).toHaveBeenCalledWith(FAKE_TX, SECRET);
    expect(deps.secretsStore.markValidated).not.toHaveBeenCalled();
  });
});

describe("cancelGuard", () => {
  it("passes an answer through", () => {
    expect(cancelGuard("answer")).toBe("answer");
  });

  it("throws WizardCancelled on the cancel symbol", () => {
    vi.mocked(p.isCancel).mockReturnValueOnce(true);
    expect(() => cancelGuard(Symbol("clack:cancel"))).toThrow(WizardCancelled);
  });
});
