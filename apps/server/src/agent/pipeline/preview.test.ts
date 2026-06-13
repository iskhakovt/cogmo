import { describe, expect, it } from "vitest";
import { renderPipelinePreview } from "./preview.js";
import { validPipelineDefinition } from "./test-fixtures.js";

describe("renderPipelinePreview", () => {
  it("renders every envelope decision — trigger, gate deadline, loop bound, tools", () => {
    const preview = renderPipelinePreview(validPipelineDefinition());

    expect(preview).toContain("**Pipeline: issue-to-pr**");
    expect(preview).toContain('Trigger: you say "start the issue pipeline"');
    // Gate is bolded with its full timeout contract — the preview IS the contract.
    expect(preview).toContain("**gate: Present the plan and get approval.**");
    expect(preview).toContain("3d timeout, reminds ×3 then aborts");
    // Loop bound with resolved step number (plan-gate is step 2).
    expect(preview).toContain("repeat from step 2");
    expect(preview).toContain("max 5 rounds");
    // Tool allowlist surfaces.
    expect(preview).toContain("memory_recall, web_search");
    // Numbered stages.
    expect(preview).toMatch(/1\. Chat with the user/);
    expect(preview).toMatch(/3\. Implement the plan/);
  });

  it("renders cron triggers and wait stages", () => {
    const def = validPipelineDefinition();
    def.trigger = { kind: "cron", schedule: "0 9 * * *", timezone: "Europe/London" };
    def.stages.push({
      id: "wait-review",
      kind: "wait",
      wait: {
        event: "github/pr.review_submitted",
        timeout: "14d",
        onTimeout: { kind: "proceed" },
      },
    });
    const preview = renderPipelinePreview(def);
    expect(preview).toContain("Trigger: on schedule `0 9 * * *` (Europe/London)");
    expect(preview).toContain("wait for `github/pr.review_submitted`");
    expect(preview).toContain("14d timeout, then proceeds");
  });
});
