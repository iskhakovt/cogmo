import type { EvolutionEventEntry, ScheduledTaskSummary } from "@cogmo/contracts";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { page } from "vitest/browser";
import { render } from "vitest-browser-react";

vi.mock("../orpc.js", () => ({
  api: {
    scheduling: { list: vi.fn() },
    evolution: { listEvents: vi.fn() },
  },
}));

import { api } from "../orpc.js";
import { SystemScreen } from "./SystemScreen.js";

function makeTask(overrides: Partial<ScheduledTaskSummary> = {}): ScheduledTaskSummary {
  return {
    id: "s1",
    kind: "recurring",
    cron: "0 9 * * *",
    prompt: "Daily digest",
    timezone: "UTC",
    nextRunAt: new Date("2026-06-04T09:00:00Z"),
    lastRunAt: null,
    enabled: true,
    ...overrides,
  };
}

function makeEvent(overrides: Partial<EvolutionEventEntry> = {}): EvolutionEventEntry {
  return {
    id: "e1abc234def567",
    conversationId: "conv-123",
    triggeredBy: "manual",
    createdAt: new Date("2026-05-20T12:00:00Z"),
    payload: {
      corrections: {
        extracted: 2,
        reinforced: 1,
        contradictions: 0,
        promoted: 1,
        outOfScopeReinforcementsSkipped: 0,
        unknownRuleReinforcementsSkipped: 0,
        consolidationNeeded: false,
      },
      consolidation: null,
      memories: { extracted: 3, byNetwork: { semantic: 2, episodic: 1 } },
      drained: { drained: 0, byNetwork: {} },
      messageCount: 10,
      profileId: "prof-9",
      durationMs: 1234,
    },
    ...overrides,
  };
}

describe("SystemScreen", () => {
  beforeEach(() => {
    vi.mocked(api.scheduling.list).mockResolvedValue([]);
    vi.mocked(api.evolution.listEvents).mockResolvedValue([]);
  });

  it("renders scheduled tasks and evolution events", async () => {
    vi.mocked(api.scheduling.list).mockResolvedValue([makeTask()]);
    vi.mocked(api.evolution.listEvents).mockResolvedValue([makeEvent()]);

    await render(<SystemScreen />);

    await expect.element(page.getByText("Daily digest")).toBeVisible();
    await expect.element(page.getByText("0 9 * * *")).toBeVisible();
    // Evolution row: trigger + the corrections summary cell.
    await expect.element(page.getByText("manual")).toBeVisible();
    await expect.element(page.getByText("+2 / ↻1 / ↑1")).toBeVisible();
  });

  it("opens a detail drawer for the clicked evolution event and closes it again", async () => {
    vi.mocked(api.evolution.listEvents).mockResolvedValue([makeEvent()]);
    await render(<SystemScreen />);

    await page.getByText("manual").click();

    // Drawer header uses the 8-char id prefix; detail lists the source ids.
    await expect.element(page.getByText("event e1abc234")).toBeVisible();
    await expect.element(page.getByText("conv-123")).toBeVisible();
    await expect.element(page.getByText("prof-9")).toBeVisible();

    await page.getByRole("button", { name: "Close" }).click();
    await expect.element(page.getByText("event e1abc234")).not.toBeInTheDocument();
  });

  it("shows empty states when there is nothing scheduled or learned", async () => {
    await render(<SystemScreen />);
    await expect.element(page.getByText("No scheduled tasks.")).toBeVisible();
    await expect.element(page.getByText("No evolution events yet.")).toBeVisible();
  });
});
