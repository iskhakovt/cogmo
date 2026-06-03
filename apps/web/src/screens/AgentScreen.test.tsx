import type { McpServerSummary, Profile, SkillListEntry } from "@cogmo/contracts";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { page } from "vitest/browser";
import { render } from "vitest-browser-react";

vi.mock("../orpc.js", () => ({
  api: {
    profiles: { list: vi.fn() },
    models: { list: vi.fn() },
    mcp: { listServers: vi.fn() },
    skills: { list: vi.fn() },
  },
}));

import { api } from "../orpc.js";
import { AgentScreen } from "./AgentScreen.js";

function makeProfile(overrides: Partial<Profile> = {}): Profile {
  return {
    id: "p1",
    userId: "u1",
    name: "Default",
    basePrompt: "",
    model: "claude-opus-4-8",
    summarizationModel: null,
    extractionModel: null,
    autoRecall: "heuristic",
    voiceMode: "auto",
    toolSet: ["web", "memory"],
    memoryScope: null,
    profileClass: null,
    streamChunkChars: 80,
    streamEdits: false,
    codingAutoapproveMode: "off",
    ...overrides,
  };
}

function makeServer(overrides: Partial<McpServerSummary> = {}): McpServerSummary {
  return {
    id: "m1",
    name: "filesystem",
    transport: "stdio",
    enabled: true,
    approvalStatus: "approved",
    toolCount: 5,
    approvedToolCount: 3,
    lastConnectedAt: new Date("2026-05-01T10:00:00Z"),
    lastError: null,
    createdAt: new Date("2026-04-01T10:00:00Z"),
    ...overrides,
  };
}

function makeSkill(overrides: Partial<SkillListEntry> = {}): SkillListEntry {
  return {
    name: "summarize",
    tier: "wasm",
    riskTier: "auto",
    disabled: false,
    gitSha: "abcdef1234567890",
    ...overrides,
  };
}

describe("AgentScreen", () => {
  beforeEach(() => {
    vi.mocked(api.profiles.list).mockResolvedValue([]);
    vi.mocked(api.models.list).mockResolvedValue([]);
    vi.mocked(api.mcp.listServers).mockResolvedValue([]);
    vi.mocked(api.skills.list).mockResolvedValue([]);
  });

  it("renders rows for each panel once the reads resolve", async () => {
    vi.mocked(api.profiles.list).mockResolvedValue([
      makeProfile({ name: "Org-wide", userId: null }),
    ]);
    vi.mocked(api.models.list).mockResolvedValue(["claude-opus-4-8", "claude-sonnet-4-6"]);
    vi.mocked(api.mcp.listServers).mockResolvedValue([makeServer()]);
    vi.mocked(api.skills.list).mockResolvedValue([makeSkill()]);

    await render(<AgentScreen />);

    // Profiles: name + org/user scope pill.
    await expect.element(page.getByText("Org-wide")).toBeVisible();
    await expect.element(page.getByText("org", { exact: true })).toBeVisible();
    // Models: each selectable model is a chip.
    await expect.element(page.getByText("claude-sonnet-4-6")).toBeVisible();
    // MCP: name, the approved/total tool count, and the approval pill.
    await expect.element(page.getByText("filesystem")).toBeVisible();
    await expect.element(page.getByText("3/5")).toBeVisible();
    await expect.element(page.getByText("approved")).toBeVisible();
    // Skills: name + the short commit sha.
    await expect.element(page.getByText("summarize")).toBeVisible();
    await expect.element(page.getByText("abcdef12")).toBeVisible();
  });

  it("shows each panel's empty state when a read returns nothing", async () => {
    await render(<AgentScreen />);
    await expect.element(page.getByText("No profiles.")).toBeVisible();
    await expect.element(page.getByText("No selectable models.")).toBeVisible();
    await expect.element(page.getByText("No MCP servers.")).toBeVisible();
    await expect.element(page.getByText("No skills.")).toBeVisible();
  });

  it("surfaces a failed read as an inline error under its panel heading", async () => {
    vi.mocked(api.profiles.list).mockRejectedValue({ data: { code: "forbidden" } });
    await render(<AgentScreen />);
    // The heading stays anchored while the body shows the transport code.
    await expect.element(page.getByText("Profiles")).toBeVisible();
    await expect.element(page.getByText("forbidden")).toBeVisible();
  });
});
