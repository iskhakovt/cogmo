/**
 * Fixture-driven tests for `classifyWithAst`. One block per category
 * we expect the AST walker to detect or not detect; the goal is a
 * scannable list where adding a skill body + asserting the
 * `(detected_effects, validation_errors, risk_tier)` triple is one
 * `it` block.
 *
 * Threat model reminder (per `ast-classifier.ts`): this is a UX gate,
 * not a security boundary. Tests assert false-positive avoidance for
 * benign idioms and the deliberate-false-negative case for dynamic
 * imports (we *expect* `__import__("os")` to slip through; sysbox
 * carries the actual security weight).
 */

import { describe, expect, it } from "vitest";
import { __resetParserForTests, classifyWithAst } from "./ast-classifier.js";
import { BUILD_CAPABILITIES } from "./capabilities.js";
import type { SkillRiskReason } from "./risk-reasons.js";
import type { SkillManifest } from "./types.js";

/** The reasons `BUILD_CAPABILITIES` adds when the table would return `auto`. */
const CAP_REASONS: SkillRiskReason[] = ["no_review_panel"];

function manifestWith(overrides: Partial<SkillManifest> = {}): SkillManifest {
  return {
    name: "test",
    description: "ast-classifier fixture skill",
    tier: "wasm",
    triggers: ["manual"],
    inputs: { type: "object", properties: {} },
    effects: [],
    secrets: [],
    dependencies: [],
    cost_per_call_usd: 0,
    ...overrides,
  } satisfies SkillManifest;
}

describe("classifyWithAst — empty / harmless body", () => {
  it("empty effects + no detectable side effects → auto, capped at notify", async () => {
    const log = await classifyWithAst(
      manifestWith(),
      `
async def run(inputs, ctx):
    return {"ok": True}
`,
      BUILD_CAPABILITIES,
    );
    expect(log.risk_tier).toBe("notify");
    expect(log.reasons).toEqual(CAP_REASONS);
    expect(log.detected_effects).toEqual([]);
    expect(log.validation_errors).toEqual([]);
  });

  it("declared `reads_memory` + harmless body → notify (declared advisory effect)", async () => {
    const log = await classifyWithAst(
      manifestWith({ effects: ["reads_memory"] }),
      `
async def run(inputs, ctx):
    memories = await ctx.memory.recall("anything")
    return {"count": len(memories["memories"])}
`,
      BUILD_CAPABILITIES,
    );
    expect(log.risk_tier).toBe("notify");
    expect(log.detected_effects).toEqual([]);
  });

  it("string-literal mentions of dangerous names do NOT trigger detection", async () => {
    // The walker matches imports + call AST nodes — not byte-level
    // greps. A skill that prints "subprocess.run is dangerous" should
    // not be flagged.
    const log = await classifyWithAst(
      manifestWith(),
      `
async def run(inputs, ctx):
    msg = "I would never call subprocess.run() or os.system() on you."
    return {"msg": msg}
`,
      BUILD_CAPABILITIES,
    );
    expect(log.risk_tier).toBe("notify");
    expect(log.reasons).toEqual(CAP_REASONS);
    expect(log.detected_effects).toEqual([]);
  });

  it("comments do NOT trigger detection", async () => {
    const log = await classifyWithAst(
      manifestWith(),
      `
async def run(inputs, ctx):
    # subprocess.run() would shell out; we don't.
    # os.remove() would delete a file; we don't.
    return {"ok": True}
`,
      BUILD_CAPABILITIES,
    );
    expect(log.risk_tier).toBe("notify");
    expect(log.reasons).toEqual(CAP_REASONS);
    expect(log.detected_effects).toEqual([]);
  });
});

describe("classifyWithAst — process spawn detection", () => {
  it.each([
    ["subprocess.run", `subprocess.run(["ls"])`],
    ["subprocess.Popen", `subprocess.Popen(["ls"])`],
    ["subprocess.call", `subprocess.call(["ls"])`],
    ["subprocess.check_output", `subprocess.check_output(["ls"])`],
    ["os.system", `os.system("ls")`],
    ["os.popen", `os.popen("ls")`],
    ["os.execv", `os.execv("/bin/ls", ["ls"])`],
    ["os.fork", `os.fork()`],
    ["os.posix_spawn", `os.posix_spawn("/bin/ls", ["ls"], {})`],
    ["multiprocessing.Process", `multiprocessing.Process(target=lambda: None)`],
  ])("detects %s as spawns_subprocess and rejects (undeclared)", async (_label, call) => {
    const log = await classifyWithAst(
      manifestWith(),
      `
import subprocess
import os
import multiprocessing
async def run(inputs, ctx):
    ${call}
    return {"ok": True}
`,
      BUILD_CAPABILITIES,
    );
    expect(log.detected_effects).toContain("spawns_subprocess");
    expect(log.risk_tier).toBe("approve");
    expect(log.validation_errors.length).toBeGreaterThan(0);
    expect(log.validation_errors[0]).toContain("spawns_subprocess");
  });

  it("declared `spawns_subprocess` + subprocess.run → approve, no validation error", async () => {
    const log = await classifyWithAst(
      manifestWith({ effects: ["spawns_subprocess"] }),
      `
import subprocess
async def run(inputs, ctx):
    subprocess.run(["echo", "hi"])
    return {"ok": True}
`,
      BUILD_CAPABILITIES,
    );
    expect(log.risk_tier).toBe("approve");
    expect(log.detected_effects).toEqual(["spawns_subprocess"]);
    expect(log.validation_errors).toEqual([]);
  });
});

describe("classifyWithAst — filesystem mutation detection", () => {
  it("detects open(..., 'w') as writes_filesystem", async () => {
    const log = await classifyWithAst(
      manifestWith(),
      `
async def run(inputs, ctx):
    open("/tmp/x", "w").write("hi")
    return {"ok": True}
`,
      BUILD_CAPABILITIES,
    );
    expect(log.detected_effects).toContain("writes_filesystem");
    expect(log.risk_tier).toBe("approve");
  });

  it.each([
    ["w", true],
    ["a", true],
    ["x", true],
    ["r+", true],
    ["wb", true],
    ["r", false],
    ["rb", false],
  ])("open(file, %s) → writesFilesystem? %s", async (mode, shouldDetect) => {
    const log = await classifyWithAst(
      manifestWith(),
      `
async def run(inputs, ctx):
    open("/tmp/x", "${mode}")
    return {"ok": True}
`,
      BUILD_CAPABILITIES,
    );
    if (shouldDetect) {
      expect(log.detected_effects).toContain("writes_filesystem");
    } else {
      expect(log.detected_effects).not.toContain("writes_filesystem");
    }
  });

  it("detects os.remove / os.unlink / shutil.rmtree", async () => {
    const log = await classifyWithAst(
      manifestWith(),
      `
import os
import shutil
async def run(inputs, ctx):
    os.remove("/tmp/a")
    os.unlink("/tmp/b")
    shutil.rmtree("/tmp/c")
    return {"ok": True}
`,
      BUILD_CAPABILITIES,
    );
    expect(log.detected_effects).toContain("writes_filesystem");
    expect(log.risk_tier).toBe("approve");
  });

  it("detects pathlib .write_text / .write_bytes (object-anywhere)", async () => {
    const log = await classifyWithAst(
      manifestWith(),
      `
from pathlib import Path
async def run(inputs, ctx):
    Path("/tmp/x").write_text("hi")
    return {"ok": True}
`,
      BUILD_CAPABILITIES,
    );
    expect(log.detected_effects).toContain("writes_filesystem");
  });

  it("declared `writes_filesystem` + os.remove → approve, no validation error", async () => {
    const log = await classifyWithAst(
      manifestWith({ effects: ["writes_filesystem"] }),
      `
import os
async def run(inputs, ctx):
    os.remove("/tmp/x")
    return {"ok": True}
`,
      BUILD_CAPABILITIES,
    );
    expect(log.detected_effects).toContain("writes_filesystem");
    expect(log.validation_errors).toEqual([]);
  });
});

describe("classifyWithAst — external messaging / financial imports", () => {
  it("smtplib import alone triggers sends_email", async () => {
    const log = await classifyWithAst(
      manifestWith(),
      `
import smtplib
async def run(inputs, ctx):
    return {"ok": True}
`,
      BUILD_CAPABILITIES,
    );
    expect(log.detected_effects).toContain("sends_email");
    expect(log.risk_tier).toBe("approve");
    expect(log.validation_errors[0]).toContain("sends_email");
    expect(log.validation_errors[0]).toContain("smtplib");
  });

  it("from smtplib import SMTP triggers sends_email", async () => {
    const log = await classifyWithAst(
      manifestWith(),
      `
from smtplib import SMTP
async def run(inputs, ctx):
    return {"ok": True}
`,
      BUILD_CAPABILITIES,
    );
    expect(log.detected_effects).toContain("sends_email");
  });

  it("checks every name of a multi-name import, aliased and dotted ones included", async () => {
    const log = await classifyWithAst(
      manifestWith(),
      `
import json, smtplib as mail, stripe.api_resources
async def run(inputs, ctx):
    return {"ok": True}
`,
      BUILD_CAPABILITIES,
    );
    expect(log.detected_effects.sort()).toEqual(["financial", "sends_email"]);
  });

  it("stripe / plaid imports trigger financial", async () => {
    const log = await classifyWithAst(
      manifestWith(),
      `
import stripe
async def run(inputs, ctx):
    return {"ok": True}
`,
      BUILD_CAPABILITIES,
    );
    expect(log.detected_effects).toContain("financial");
    expect(log.risk_tier).toBe("approve");
  });

  it("slack_sdk / discord / telegram / twilio → sends_message", async () => {
    const log = await classifyWithAst(
      manifestWith(),
      `
import slack_sdk
async def run(inputs, ctx):
    return {"ok": True}
`,
      BUILD_CAPABILITIES,
    );
    expect(log.detected_effects).toContain("sends_message");
  });

  it("subprocess import alone (no call) still triggers spawns_subprocess", async () => {
    // The mere import says "this skill plans to shell out." Reject
    // even if the call site is dynamic / hidden — false positives
    // are accepted (operator just declares the effect).
    const log = await classifyWithAst(
      manifestWith(),
      `
import subprocess
async def run(inputs, ctx):
    return {"ok": True}
`,
      BUILD_CAPABILITIES,
    );
    expect(log.detected_effects).toContain("spawns_subprocess");
  });
});

describe("classifyWithAst — dynamic / aliased bypass (deliberate FN)", () => {
  it("getattr(__import__('os'), 'system')(...) is NOT detected (security boundary lives elsewhere)", async () => {
    // We document this explicitly because it's the obvious bypass
    // and we want the test suite to assert "yes, this slips through —
    // by design." If a future rule does start catching it, that's
    // useful, but it's not the security guarantee.
    const log = await classifyWithAst(
      manifestWith(),
      `
async def run(inputs, ctx):
    getattr(__import__("os"), "system")("ls")
    return {"ok": True}
`,
      BUILD_CAPABILITIES,
    );
    expect(log.detected_effects).not.toContain("spawns_subprocess");
    // Nothing in the rules table matches, so only the tier-1 cap applies.
    expect(log.risk_tier).toBe("notify");
    expect(log.reasons).toEqual(CAP_REASONS);
  });

  it("aliased import (`import subprocess as sp`) is detected via the import statement", async () => {
    // The import rule fires regardless of `as` alias because we
    // match the dotted name, not the binding. The call-site alias
    // (`sp.run(...)`) wouldn't match the call rule, but the import
    // alone is enough to flag the skill.
    const log = await classifyWithAst(
      manifestWith(),
      `
import subprocess as sp
async def run(inputs, ctx):
    sp.run(["ls"])
    return {"ok": True}
`,
      BUILD_CAPABILITIES,
    );
    expect(log.detected_effects).toContain("spawns_subprocess");
  });
});

describe("classifyWithAst — multiple effects + tier interaction", () => {
  it("declared sends_email + smtplib usage + container tier → approve, no errors", async () => {
    const log = await classifyWithAst(
      manifestWith({ tier: "container", effects: ["sends_email"] }),
      `
import smtplib
async def run(inputs, ctx):
    smtplib.SMTP("localhost").sendmail("a", "b", "c")
    return {"ok": True}
`,
      BUILD_CAPABILITIES,
    );
    expect(log.risk_tier).toBe("approve");
    expect(log.validation_errors).toEqual([]);
  });

  it("multiple undeclared effects → multiple validation_errors", async () => {
    const log = await classifyWithAst(
      manifestWith(),
      `
import smtplib
import subprocess
async def run(inputs, ctx):
    smtplib.SMTP("localhost").sendmail("a", "b", "c")
    subprocess.run(["ls"])
    return {"ok": True}
`,
      BUILD_CAPABILITIES,
    );
    expect(log.detected_effects.sort()).toEqual(["sends_email", "spawns_subprocess"]);
    expect(log.validation_errors.length).toBe(2);
    expect(log.validation_errors.some((e) => e.includes("sends_email"))).toBe(true);
    expect(log.validation_errors.some((e) => e.includes("spawns_subprocess"))).toBe(true);
  });

  it("3+ secrets force approve even with empty effects", async () => {
    const log = await classifyWithAst(
      manifestWith({ secrets: ["a", "b", "c"] }),
      `
async def run(inputs, ctx):
    return {"ok": True}
`,
      BUILD_CAPABILITIES,
    );
    expect(log.risk_tier).toBe("approve");
    expect(log.declared_secrets).toEqual(["a", "b", "c"]);
  });
});

describe("classifyWithAst — recovery", () => {
  it("syntax errors in the body still produce a (degraded) tree; no exception", async () => {
    // tree-sitter is error-tolerant by design — broken Python yields
    // a tree with `ERROR` nodes but the walker still completes.
    // Rules don't match the broken parts, but well-formed parts that
    // happen to coexist do. Important: the classifier does not throw
    // and does not fall back to the stub at this layer.
    const log = await classifyWithAst(
      manifestWith(),
      `
def broken(:
import smtplib
async def run(inputs, ctx):
    return {"ok": True}
`,
      BUILD_CAPABILITIES,
    );
    expect(log.detected_effects).toContain("sends_email");
  });

  it("__resetParserForTests forces a clean re-init", async () => {
    // First call inits the parser; reset; second call re-inits cleanly.
    await classifyWithAst(
      manifestWith(),
      `async def run(inputs, ctx):\n    return {}`,
      BUILD_CAPABILITIES,
    );
    __resetParserForTests();
    const log = await classifyWithAst(
      manifestWith(),
      `async def run(inputs, ctx):\n    return {}`,
      BUILD_CAPABILITIES,
    );
    expect(log.risk_tier).toBe("notify");
    expect(log.reasons).toEqual(CAP_REASONS);
  });
});

describe("classifyWithAst — network and secrets", () => {
  const BODY = `
async def run(inputs, ctx):
    resp = await ctx.http.get("https://api.example.com/v1")
    return {"body": resp["body"]}
`;

  it("network with no secrets → notify", async () => {
    // Egress reaches only what the allowlist named and carries no
    // credential, so it is worth a note rather than a gate.
    const log = await classifyWithAst(
      manifestWith({ network: { allow: ["api.example.com"] } }),
      BODY,
      BUILD_CAPABILITIES,
    );
    expect(log.risk_tier).toBe("notify");
  });

  it("one secret alongside network → approve, below the count threshold", async () => {
    // APPROVE_SECRETS_THRESHOLD is 3; the pairing gates regardless, because
    // reading a credential and having somewhere to send it is the shape that
    // matters rather than how many credentials there are.
    const log = await classifyWithAst(
      manifestWith({
        secrets: ["api_key"],
        network: { allow: ["api.example.com"] },
      }),
      BODY,
      BUILD_CAPABILITIES,
    );
    expect(log.risk_tier).toBe("approve");
  });

  it("two secrets alongside network → approve", async () => {
    const log = await classifyWithAst(
      manifestWith({
        secrets: ["api_key", "other_key"],
        network: { allow: ["api.example.com"] },
      }),
      BODY,
      BUILD_CAPABILITIES,
    );
    expect(log.risk_tier).toBe("approve");
  });

  it("one secret with no network stays auto, capped at notify", async () => {
    // The pairing is what gates. A secret a skill cannot send anywhere is
    // still only as broad as the count threshold says.
    const log = await classifyWithAst(
      manifestWith({ secrets: ["api_key"] }),
      `
async def run(inputs, ctx):
    return {"ok": True}
`,
      BUILD_CAPABILITIES,
    );
    expect(log.risk_tier).toBe("notify");
    expect(log.reasons).toEqual(CAP_REASONS);
  });

  it("a bound secret alongside network → approve, same as a bare one", async () => {
    const log = await classifyWithAst(
      manifestWith({
        secrets: [{ name: "api_key", binding: { destination: "https://api.example.com/*" } }],
        network: { allow: ["api.example.com"] },
      }),
      BODY,
      BUILD_CAPABILITIES,
    );
    expect(log.risk_tier).toBe("approve");
  });
});

describe("classifyWithAst — tier-1 cap", () => {
  const HARMLESS = `
async def run(inputs, ctx):
    return {"ok": True}
`;

  it("caps auto at notify with both cap reasons while both flags are off", async () => {
    const log = await classifyWithAst(manifestWith(), HARMLESS, {
      tier1Hardened: false,
      reviewPanel: false,
      tier1MemoryBounded: false,
    });
    expect(log.risk_tier).toBe("notify");
    expect(log.reasons).toEqual(["tier1_unhardened", "no_review_panel"]);
    expect(log.capabilities).toEqual({
      tier1Hardened: false,
      reviewPanel: false,
      tier1MemoryBounded: false,
    });
  });

  it("records only tier1_unhardened once a review panel is set", async () => {
    const log = await classifyWithAst(manifestWith(), HARMLESS, {
      tier1Hardened: false,
      reviewPanel: true,
      tier1MemoryBounded: false,
    });
    expect(log.risk_tier).toBe("notify");
    expect(log.reasons).toEqual(["tier1_unhardened"]);
  });

  it("records only no_review_panel once tier 1 is hardened", async () => {
    const log = await classifyWithAst(manifestWith(), HARMLESS, {
      tier1Hardened: true,
      reviewPanel: false,
      tier1MemoryBounded: false,
    });
    expect(log.risk_tier).toBe("notify");
    expect(log.reasons).toEqual(["no_review_panel"]);
  });

  it("returns auto with no reasons when both flags are set", async () => {
    const log = await classifyWithAst(manifestWith(), HARMLESS, {
      tier1Hardened: true,
      reviewPanel: true,
      tier1MemoryBounded: false,
    });
    expect(log.risk_tier).toBe("auto");
    expect(log.reasons).toEqual([]);
    expect(log.capabilities).toEqual({
      tier1Hardened: true,
      reviewPanel: true,
      tier1MemoryBounded: false,
    });
  });

  it("leaves a notify deploy's reasons free of the cap", async () => {
    const log = await classifyWithAst(
      manifestWith({ effects: ["reads_memory"] }),
      HARMLESS,
      BUILD_CAPABILITIES,
    );
    expect(log.risk_tier).toBe("notify");
    expect(log.reasons).toEqual(["declared_effect"]);
  });
});

describe("classifyWithAst — reasons", () => {
  const HARMLESS = `
async def run(inputs, ctx):
    return {"ok": True}
`;
  const NETWORK = { allow: ["api.example.com"] };

  it.each<[SkillRiskReason, Partial<SkillManifest>, "notify" | "approve"]>([
    ["sensitive_dependency", { dependencies: ["boto3==1.34.0"] }, "approve"],
    ["approve_gating_effect", { effects: ["sends_email"] }, "approve"],
    ["container_tier", { tier: "container" }, "approve"],
    ["secrets_with_network", { secrets: ["api_key"], network: NETWORK }, "approve"],
    ["secret_breadth", { secrets: ["a", "b", "c"] }, "approve"],
    ["unlisted_dependency", { dependencies: ["some-obscure-pkg==1.0.0"] }, "notify"],
    ["declared_effect", { effects: ["reads_memory"] }, "notify"],
    ["network_declared", { network: NETWORK }, "notify"],
  ])("raises %s alone for its trigger", async (reason, overrides, tier) => {
    const log = await classifyWithAst(manifestWith(overrides), HARMLESS, BUILD_CAPABILITIES);
    expect(log.risk_tier).toBe(tier);
    expect(log.reasons).toEqual([reason]);
  });

  it("raises approve_gating_effect for a detected effect, without the cap", async () => {
    const log = await classifyWithAst(
      manifestWith(),
      `
import smtplib
async def run(inputs, ctx):
    return {"ok": True}
`,
      BUILD_CAPABILITIES,
    );
    expect(log.risk_tier).toBe("approve");
    expect(log.validation_errors).toHaveLength(1);
    expect(log.reasons).toEqual(["approve_gating_effect"]);
  });

  it("records both reasons for a container-tier skill with an unlisted dependency", async () => {
    const log = await classifyWithAst(
      manifestWith({ tier: "container", dependencies: ["some-obscure-pkg==1.0.0"] }),
      HARMLESS,
      BUILD_CAPABILITIES,
    );
    expect(log.risk_tier).toBe("approve");
    expect(log.reasons).toEqual(["container_tier", "unlisted_dependency"]);
  });

  it("records a gating and a non-gating effect as separate reasons", async () => {
    const log = await classifyWithAst(
      manifestWith({ effects: ["sends_email", "reads_memory"] }),
      HARMLESS,
      BUILD_CAPABILITIES,
    );
    expect(log.risk_tier).toBe("approve");
    expect(log.reasons).toEqual(["approve_gating_effect", "declared_effect"]);
  });

  it("records secret breadth and the network pairing together", async () => {
    const log = await classifyWithAst(
      manifestWith({ secrets: ["a", "b", "c"], network: NETWORK }),
      HARMLESS,
      BUILD_CAPABILITIES,
    );
    expect(log.risk_tier).toBe("approve");
    expect(log.reasons).toEqual(["secrets_with_network", "secret_breadth"]);
  });

  it("records an approve-list and an unlisted dependency together", async () => {
    const log = await classifyWithAst(
      manifestWith({ dependencies: ["paramiko==3.4.0", "some-obscure-pkg==1.0.0"] }),
      HARMLESS,
      BUILD_CAPABILITIES,
    );
    expect(log.risk_tier).toBe("approve");
    expect(log.reasons).toEqual(["sensitive_dependency", "unlisted_dependency"]);
  });

  it("stamps declared_network from the manifest's allowlist", async () => {
    const withNetwork = await classifyWithAst(
      manifestWith({ network: NETWORK }),
      HARMLESS,
      BUILD_CAPABILITIES,
    );
    expect(withNetwork.declared_network).toEqual(["api.example.com"]);
    const without = await classifyWithAst(manifestWith(), HARMLESS, BUILD_CAPABILITIES);
    expect(without.declared_network).toBeNull();
  });
});
