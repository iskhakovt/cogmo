import { describe, expect, it } from "vitest";
import { parseManifest } from "./manifest.js";

const MIN_FIELDS = `
name: my-skill
description: A short description that is longer than ten characters.
tier: wasm
inputs:
  type: object
  properties: {}
`.trim();

function frontmatter(yaml: string, body = ""): string {
  return `---\n${yaml}\n---\n${body}`;
}

describe("parseManifest", () => {
  it("parses a minimal manifest", () => {
    const result = parseManifest(frontmatter(MIN_FIELDS, "# Body\n"));
    expect(result.isOk()).toBe(true);
    if (!result.isOk()) return;
    expect(result.value.manifest.name).toBe("my-skill");
    expect(result.value.manifest.tier).toBe("wasm");
    expect(result.value.manifest.triggers).toEqual(["manual"]);
    expect(result.value.manifest.effects).toEqual([]);
    expect(result.value.manifest.cost_per_call_usd).toBe(0);
    expect(result.value.body).toBe("# Body\n");
  });

  it("parses a full manifest matching the design-doc example", () => {
    const yaml = `
name: send-morning-digest
description: >-
  Send a one-paragraph summary of unread email to the morning Telegram chat.
tier: container
isolation: subinterpreter
triggers: [manual, cron]
schedule: "0 9 * * *"
inputs:
  type: object
  properties:
    since: { type: string, format: date-time }
  required: []
outputs:
  type: object
  properties:
    summary: { type: string }
effects:
  - reads_user_data
  - sends_message
secrets:
  - telegram_bot_token
  - name: gmail_oauth
    binding:
      destination: "https://gmail.googleapis.com/*"
resources:
  memory_mb: 512
  wall_clock_s: 60
  cpu_shares: 1
cost_per_call_usd: 0.001
budget:
  daily_usd: 0.50
  monthly_usd: 10.00
`.trim();
    const result = parseManifest(frontmatter(yaml));
    expect(result.isOk()).toBe(true);
    if (!result.isOk()) return;
    const m = result.value.manifest;
    expect(m.name).toBe("send-morning-digest");
    expect(m.tier).toBe("container");
    expect(m.isolation).toBe("subinterpreter");
    expect(m.triggers).toEqual(["manual", "cron"]);
    expect(m.schedule).toBe("0 9 * * *");
    expect(m.effects).toEqual(["reads_user_data", "sends_message"]);
    expect(m.secrets).toHaveLength(2);
    expect(m.budget?.daily_usd).toBe(0.5);
  });

  it("rejects a source with no frontmatter", () => {
    const result = parseManifest("# just a markdown body\n");
    expect(result.isErr()).toBe(true);
    if (!result.isErr()) return;
    expect(result.error.kind).toBe("missing_frontmatter");
  });

  it("rejects malformed YAML", () => {
    const result = parseManifest(frontmatter("name: my-skill\n  bad: : yaml"));
    expect(result.isErr()).toBe(true);
    if (!result.isErr()) return;
    expect(result.error.kind).toBe("invalid_yaml");
  });

  it("rejects a name that doesn't match the regex", () => {
    const yaml = MIN_FIELDS.replace("my-skill", "Bad_Name");
    const result = parseManifest(frontmatter(yaml));
    expect(result.isErr()).toBe(true);
    if (!result.isErr()) return;
    expect(result.error.kind).toBe("invalid_manifest");
    expect(result.error.issues.join("|")).toContain("name");
  });

  it("rejects cron triggers without a schedule", () => {
    const yaml = `${MIN_FIELDS}\ntriggers: [cron]`;
    const result = parseManifest(frontmatter(yaml));
    expect(result.isErr()).toBe(true);
    if (!result.isErr()) return;
    expect(result.error.kind).toBe("invalid_manifest");
    expect(result.error.issues.some((i) => i.includes("schedule"))).toBe(true);
  });

  it("silently drops `isolation` when tier is wasm", () => {
    const yaml = `${MIN_FIELDS}\nisolation: subinterpreter`;
    const result = parseManifest(frontmatter(yaml));
    expect(result.isOk()).toBe(true);
    if (!result.isOk()) return;
    expect(result.value.manifest.isolation).toBeUndefined();
  });

  it("rejects unknown effects", () => {
    const yaml = `${MIN_FIELDS}\neffects: [reads_memory, no_such_effect]`;
    const result = parseManifest(frontmatter(yaml));
    expect(result.isErr()).toBe(true);
    if (!result.isErr()) return;
    expect(result.error.kind).toBe("invalid_manifest");
  });

  it("rejects a description shorter than 10 chars", () => {
    const yaml = MIN_FIELDS.replace(/description: .*/, "description: short");
    const result = parseManifest(frontmatter(yaml));
    expect(result.isErr()).toBe(true);
    if (!result.isErr()) return;
    expect(result.error.kind).toBe("invalid_manifest");
  });

  it("rejects resources.memory_mb above 2048", () => {
    const yaml = `${MIN_FIELDS}\nresources:\n  memory_mb: 4096`;
    const result = parseManifest(frontmatter(yaml));
    expect(result.isErr()).toBe(true);
  });

  it("preserves a markdown body with --- thematic-break lines", () => {
    const body = "# Title\n\n---\n\n## Section\n\n---\n\nMore text\n";
    const result = parseManifest(frontmatter(MIN_FIELDS, body));
    expect(result.isOk()).toBe(true);
    if (!result.isOk()) return;
    expect(result.value.body).toBe(body);
  });

  it("rejects an empty frontmatter block", () => {
    // `---\n---\n` has zero content lines between the delimiters — the regex
    // requires at least one `\n` before the closing `---`, so this is treated
    // as missing_frontmatter. Adding a blank line between `---` lines parses
    // as null YAML and surfaces as invalid_manifest.
    const result = parseManifest("---\n\n---\n");
    expect(result.isErr()).toBe(true);
    if (!result.isErr()) return;
    expect(["invalid_yaml", "invalid_manifest"]).toContain(result.error.kind);
  });

  it("handles CRLF line endings", () => {
    const source = `---\r\n${MIN_FIELDS.replaceAll("\n", "\r\n")}\r\n---\r\nbody\r\n`;
    const result = parseManifest(source);
    expect(result.isOk()).toBe(true);
    if (!result.isOk()) return;
    expect(result.value.manifest.name).toBe("my-skill");
  });

  it("rejects a frontmatter block with no closing delimiter", () => {
    const source = `---\n${MIN_FIELDS}\nbody without closing delimiter\n`;
    const result = parseManifest(source);
    expect(result.isErr()).toBe(true);
    if (!result.isErr()) return;
    expect(result.error.kind).toBe("missing_frontmatter");
  });

  it("rejects a unicode name", () => {
    const yaml = MIN_FIELDS.replace("my-skill", "skill-名前");
    const result = parseManifest(frontmatter(yaml));
    expect(result.isErr()).toBe(true);
    if (!result.isErr()) return;
    expect(result.error.kind).toBe("invalid_manifest");
  });

  it("accepts mixed bare-string and object-form secrets", () => {
    const yaml = `${MIN_FIELDS}
secrets:
  - bare_secret
  - name: scoped_secret
    binding:
      destination: "https://api.example.com/*"`;
    const result = parseManifest(frontmatter(yaml));
    expect(result.isOk()).toBe(true);
    if (!result.isOk()) return;
    expect(result.value.manifest.secrets).toHaveLength(2);
  });

  it("returns an empty body when nothing follows the closing delimiter", () => {
    const result = parseManifest(frontmatter(MIN_FIELDS));
    expect(result.isOk()).toBe(true);
    if (!result.isOk()) return;
    expect(result.value.body).toBe("");
  });
});
