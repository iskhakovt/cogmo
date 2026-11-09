import { err, ok, type Result } from "neverthrow";
import * as R from "remeda";
import { describe, expect, it, vi } from "vitest";
import { classifyWithAst } from "../ast-classifier.js";
import { BUILD_CAPABILITIES } from "../capabilities.js";
import { classifyManifestStub } from "../classifier.js";
import { runSkillGates, type SkillFinding } from "../skill-gates.js";
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

describe("checkRegisterBody with the gates and the classifier register wires", () => {
  const WIRED = { runGates: runSkillGates, classify: classifyWithAst };
  const NETWORK: SkillManifest = { ...MANIFEST, network: { allow: ["api.example.com"] } };

  /** A valid `run` reading `lines - 3` response headers, each a call on a non-ctx receiver. */
  const headers = (lines: number) =>
    [
      "import urllib.parse",
      "async def run(inputs, ctx):",
      '    resp = await ctx.http.get("https://api.example.com/")',
      ...R.times(
        lines - 3,
        (i) => `    v${i} = urllib.parse.quote(resp.headers.get("x-${i}", ""))`,
      ),
      "",
    ].join("\n");

  async function timed(body: string) {
    const started = performance.now();
    const checked = await checkRegisterBody(
      WIRED,
      { ...SKILL, manifest: NETWORK, body },
      BUILD_CAPABILITIES,
    );
    return { checked, ms: performance.now() - started };
  }

  it("checks a body at the line bound in under a second", { timeout: 120_000 }, async () => {
    const body = headers(400);
    expect(body.split("\n").length - 1).toBe(400);
    expect(body.length).toBeLessThan(48_000);

    const { checked, ms } = await timed(body);
    expect(checked.isOk()).toBe(true);
    expect(ms).toBeLessThan(1000);
  });

  it("classifies a 2000-term chain rather than pausing", { timeout: 120_000 }, async () => {
    const names = R.times(2000, (i) => `a${i}`);
    const rows = R.chunk(names, 21).map((row) => `    ${row.join(" + ")}`);
    const body = `${SKILL.body}x = (\n${rows.join(" +\n")}\n)\n`;

    const { checked, ms } = await timed(body);
    expect(checked.isOk()).toBe(true);
    expect(ms).toBeLessThan(1000);
  });
});
