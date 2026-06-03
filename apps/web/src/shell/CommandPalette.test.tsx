import { beforeEach, describe, expect, it, vi } from "vitest";
import { page, userEvent } from "vitest/browser";
import { render } from "vitest-browser-react";

const navigate = vi.hoisted(() => vi.fn());
const createConversation = vi.hoisted(() => vi.fn());

vi.mock("@tanstack/react-router", () => ({ useNavigate: () => navigate }));
vi.mock("../chat/chat-api.js", () => ({ createConversation }));

import { AppProvider } from "../app-context.js";
import { CommandPalette } from "./CommandPalette.js";

function renderPalette() {
  const toggleTheme = vi.fn();
  const logout = vi.fn(() => Promise.resolve());
  render(
    <AppProvider value={{ tab: "tab-1", logout }}>
      <CommandPalette toggleTheme={toggleTheme} logout={logout} />
    </AppProvider>,
  );
  return { toggleTheme, logout };
}

async function openPalette() {
  await userEvent.keyboard("{Meta>}k{/Meta}");
  await expect.element(page.getByPlaceholder(/Jump to a section/)).toBeVisible();
}

describe("CommandPalette", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("is closed until the meta+k chord opens it, and Escape closes it again", async () => {
    renderPalette();
    await expect.element(page.getByPlaceholder(/Jump to a section/)).not.toBeInTheDocument();

    await openPalette();

    await userEvent.keyboard("{Escape}");
    await expect.element(page.getByPlaceholder(/Jump to a section/)).not.toBeInTheDocument();
  });

  it("navigates to the selected section", async () => {
    renderPalette();
    await openPalette();

    await page.getByText("Memory").click();

    expect(navigate).toHaveBeenCalledWith({ to: "/memory" });
  });

  it("runs the toggle-theme and log-out actions", async () => {
    const { toggleTheme, logout } = renderPalette();

    await openPalette();
    await page.getByText("Toggle theme").click();
    expect(toggleTheme).toHaveBeenCalledTimes(1);

    await openPalette();
    await page.getByText("Log out").click();
    expect(logout).toHaveBeenCalledTimes(1);
  });

  it("starts a new chat and routes to its conversation", async () => {
    createConversation.mockResolvedValue("conv-9");
    renderPalette();
    await openPalette();

    await page.getByText("New chat").click();

    await expect.poll(() => createConversation.mock.calls.length).toBe(1);
    expect(createConversation).toHaveBeenCalledWith("tab-1");
    await expect.poll(() => navigate.mock.calls.length).toBeGreaterThan(0);
    expect(navigate).toHaveBeenCalledWith({
      to: "/chat/$conversationId",
      params: { conversationId: "conv-9" },
    });
  });
});
