import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { page } from "vitest/browser";
import { render } from "vitest-browser-react";

const modelsList = vi.hoisted(() => vi.fn());

vi.mock("./orpc.js", () => ({ api: { models: { list: modelsList } } }));
vi.mock("./router.js", () => ({ router: {} }));
vi.mock("@tanstack/react-router", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@tanstack/react-router")>();
  return { ...actual, RouterProvider: () => <div>ROUTED COCKPIT</div> };
});

import { App } from "./App.js";

describe("App auth boundary", () => {
  beforeEach(() => {
    modelsList.mockReset();
  });
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it("mounts the cockpit when the session probe succeeds", async () => {
    modelsList.mockResolvedValue([]);
    await render(<App />);
    await expect.element(page.getByText("ROUTED COCKPIT")).toBeVisible();
  });

  it("falls back to the login screen when the probe fails", async () => {
    modelsList.mockRejectedValue(new Error("401"));
    await render(<App />);
    await expect.element(page.getByText("Login token")).toBeVisible();
    await expect.element(page.getByRole("button", { name: "Sign in" })).toBeVisible();
  });

  it("logs in: posts the token, then re-probes into the cockpit", async () => {
    modelsList.mockRejectedValueOnce(new Error("401")).mockResolvedValue([]);
    const fetchMock = vi.fn((_url: string, _init?: RequestInit) =>
      Promise.resolve({ ok: true, status: 200 }),
    );
    vi.stubGlobal("fetch", fetchMock);

    await render(<App />);
    await page.getByLabelText("Login token").fill("s3cret");
    await page.getByRole("button", { name: "Sign in" }).click();

    await expect.element(page.getByText("ROUTED COCKPIT")).toBeVisible();
    expect(fetchMock).toHaveBeenCalledWith(
      "/api/session",
      expect.objectContaining({ method: "POST" }),
    );
  });

  it("shows an invalid-token message on a 401 from the login endpoint", async () => {
    modelsList.mockRejectedValue(new Error("401"));
    vi.stubGlobal(
      "fetch",
      vi.fn(() => Promise.resolve({ ok: false, status: 401 })),
    );

    await render(<App />);
    await page.getByLabelText("Login token").fill("wrong");
    await page.getByRole("button", { name: "Sign in" }).click();

    await expect.element(page.getByText("Invalid token.")).toBeVisible();
  });
});
