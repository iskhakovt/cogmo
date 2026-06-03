import { describe, expect, it, vi } from "vitest";
import { page } from "vitest/browser";
import { render } from "vitest-browser-react";
import { Drawer, EmptyRow, fmtDateTime, PanelResource, Pill, Resource } from "./screen-kit.js";
import type { ResourceState } from "./use-resource.js";

describe("Resource", () => {
  it("shows the loading placeholder", async () => {
    await render(<Resource state={{ status: "loading" }}>{() => <span>body</span>}</Resource>);
    await expect.element(page.getByText("Loading…")).toBeVisible();
  });

  it("shows the error message", async () => {
    await render(
      <Resource state={{ status: "error", message: "rate_limited" }}>
        {() => <span>body</span>}
      </Resource>,
    );
    await expect.element(page.getByText("rate_limited")).toBeVisible();
  });

  it("renders children with the ready data", async () => {
    const state: ResourceState<string> = { status: "ready", data: "the-data" };
    await render(<Resource state={state}>{(d) => <span>{d}</span>}</Resource>);
    await expect.element(page.getByText("the-data")).toBeVisible();
  });
});

describe("PanelResource", () => {
  it("keeps the title while loading and shows no count yet", async () => {
    const state: ResourceState<readonly string[]> = { status: "loading" };
    await render(
      <PanelResource title="Profiles" state={state}>
        {() => <span>rows</span>}
      </PanelResource>,
    );
    await expect.element(page.getByText("Profiles")).toBeVisible();
    await expect.element(page.getByText("Loading…")).toBeVisible();
  });

  it("shows the row count once ready", async () => {
    const state: ResourceState<readonly string[]> = { status: "ready", data: ["a", "b", "c"] };
    await render(
      <PanelResource title="Profiles" state={state}>
        {(rows) => <span>{rows.join(",")}</span>}
      </PanelResource>,
    );
    await expect.element(page.getByText("Profiles")).toBeVisible();
    await expect.element(page.getByText("3")).toBeVisible();
    await expect.element(page.getByText("a,b,c")).toBeVisible();
  });
});

describe("Pill", () => {
  it("maps each tone onto its trust-palette classes", async () => {
    await render(
      <>
        <Pill tone="ok">live</Pill>
        <Pill tone="warn">pending</Pill>
        <Pill tone="bad">failed</Pill>
        <Pill tone="muted">off</Pill>
      </>,
    );
    expect(page.getByText("live").element().className).toContain("text-ok");
    expect(page.getByText("pending").element().className).toContain("text-warn");
    expect(page.getByText("failed").element().className).toContain("text-bad");
    expect(page.getByText("off").element().className).toContain("text-muted");
  });
});

describe("EmptyRow", () => {
  it("spans the given column count", async () => {
    await render(
      <table>
        <tbody>
          <EmptyRow colSpan={4} label="No profiles." />
        </tbody>
      </table>,
    );
    const cell = page.getByText("No profiles.").element();
    expect(cell.getAttribute("colspan")).toBe("4");
  });
});

describe("Drawer", () => {
  it("renders the title and body and fires onClose from the Close button", async () => {
    const onClose = vi.fn();
    await render(
      <Drawer title="event abcd" onClose={onClose}>
        <p>detail body</p>
      </Drawer>,
    );
    await expect.element(page.getByText("event abcd")).toBeVisible();
    await expect.element(page.getByText("detail body")).toBeVisible();

    await page.getByRole("button", { name: "Close" }).click();
    expect(onClose).toHaveBeenCalledTimes(1);
  });
});

describe("fmtDateTime", () => {
  it("renders an em-dash for a missing date", () => {
    expect(fmtDateTime(null)).toBe("—");
    expect(fmtDateTime(undefined)).toBe("—");
  });

  it("formats a real date with its year", () => {
    expect(fmtDateTime(new Date("2026-03-04T08:09:00Z"))).toMatch(/2026/);
  });
});
