import { err, ok, type Result } from "neverthrow";
import { describe, expect, it, vi } from "vitest";
import { BUILD_CAPABILITIES } from "../capabilities.js";
import { classifyManifestStub } from "../classifier.js";
import type { SkillFinding } from "../skill-gates.js";
import type { ClassifierLog, SkillManifest } from "../types.js";
import { checkRegisterBody } from "./check-register-body.js";

type RegisterBodyChecks = Parameters<typeof checkRegisterBody>[0];

const MANIFEST: SkillManifest = {
  name: "echo",
  description: "check-register-body fixture skill",
  tier: "wasm",
  triggers: ["manual"],
  inputs: { type: "object", properties: {} },
  effects: [],
  secrets: [],
  dependencies: [],
  cost_per_call_usd: 0,
};

const SKILL = { name: "echo", manifest: MANIFEST, body: "async def run(inputs, ctx):\n    pass\n" };

function classifierLog(validationErrors: string[]): ClassifierLog {
  return {
    ...classifyManifestStub(MANIFEST, BUILD_CAPABILITIES),
    classifier_version: "ast-3",
    validation_errors: validationErrors,
  };
}

/** The tree the fake gates hand on; nothing reads into it. */
const FAKE_TREE = { __mockTree: true } as never;

type Gated = Result<ClassifierLog, readonly SkillFinding[]>;

/**
 * Fakes for the gates and the classifier, each answering or throwing as
 * given. `gates` errs with findings, or passes by handing `FAKE_TREE` on.
 */
function checks(gates: (pass: () => Gated) => Promise<Gated>, classify: () => ClassifierLog) {
  return {
    runGates: vi.fn<RegisterBodyChecks["runGates"]>((_skill, read) =>
      gates(() => ok(read(FAKE_TREE))),
    ),
    classify: vi.fn<RegisterBodyChecks["classify"]>(classify),
  };
}

const FINDING: SkillFinding = {
  id: "entrypoint",
  path: "skills/echo/skill.py",
  line: 1,
  column: 1,
  message: "a",
};

describe("checkRegisterBody", () => {
  it("returns the classifier's log on the tree the gates parsed, once they pass", async () => {
    const log = classifierLog([]);
    const fakes = checks(
      async (pass) => pass(),
      () => log,
    );

    expect((await checkRegisterBody(fakes, SKILL, BUILD_CAPABILITIES))._unsafeUnwrap()).toBe(log);
    expect(fakes.runGates).toHaveBeenCalledWith(SKILL, expect.any(Function));
    expect(fakes.classify).toHaveBeenCalledWith(FAKE_TREE, MANIFEST, BUILD_CAPABILITIES);
  });

  it("rejects as lint_failed with the gates' findings, without running the classifier", async () => {
    const fakes = checks(
      async () => err([FINDING]),
      () => classifierLog([]),
    );

    expect((await checkRegisterBody(fakes, SKILL, BUILD_CAPABILITIES))._unsafeUnwrapErr()).toEqual({
      kind: "lint_failed",
      findings: [FINDING],
    });
    expect(fakes.classify).not.toHaveBeenCalled();
  });

  it("rejects as classifier_rejected with the validation errors", async () => {
    const fakes = checks(
      async (pass) => pass(),
      () => classifierLog(["first", "second"]),
    );

    expect((await checkRegisterBody(fakes, SKILL, BUILD_CAPABILITIES))._unsafeUnwrapErr()).toEqual({
      kind: "classifier_rejected",
      validationErrors: ["first", "second"],
    });
  });

  it("pauses when a gate's parse or walk throws", async () => {
    const fakes = checks(
      () => Promise.reject(new Error("tree-sitter-python.wasm: ENOENT")),
      () => classifierLog([]),
    );

    expect((await checkRegisterBody(fakes, SKILL, BUILD_CAPABILITIES))._unsafeUnwrapErr()).toEqual({
      kind: "registrar_unavailable",
      cause: "parser",
      detail: "tree-sitter-python.wasm: ENOENT",
    });
    expect(fakes.classify).not.toHaveBeenCalled();
  });

  it("pauses when the classifier throws after the gates passed, rather than taking the stub", async () => {
    const fakes = checks(
      async (pass) => pass(),
      () => {
        throw new Error("walk panic");
      },
    );

    expect((await checkRegisterBody(fakes, SKILL, BUILD_CAPABILITIES))._unsafeUnwrapErr()).toEqual({
      kind: "registrar_unavailable",
      cause: "parser",
      detail: "walk panic",
    });
  });
});
