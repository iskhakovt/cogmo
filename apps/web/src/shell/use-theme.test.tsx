import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { renderHook } from "vitest-browser-react";
import { useTheme } from "./use-theme.js";

const STORAGE_KEY = "cogmo-theme";

describe("useTheme", () => {
  beforeEach(() => {
    document.documentElement.removeAttribute("data-theme");
    localStorage.removeItem(STORAGE_KEY);
  });
  afterEach(() => {
    document.documentElement.removeAttribute("data-theme");
    localStorage.removeItem(STORAGE_KEY);
  });

  it("defaults to dark when no data-theme is set", async () => {
    const { result } = await renderHook(() => useTheme());
    expect(result.current[0]).toBe("dark");
  });

  it("reads an initial light theme from the document element", async () => {
    document.documentElement.dataset.theme = "light";
    const { result } = await renderHook(() => useTheme());
    expect(result.current[0]).toBe("light");
  });

  it("toggles the theme, the data-theme attribute, and localStorage together", async () => {
    const { result, act } = await renderHook(() => useTheme());
    expect(result.current[0]).toBe("dark");

    await act(() => result.current[1]());

    expect(result.current[0]).toBe("light");
    expect(document.documentElement.dataset.theme).toBe("light");
    expect(localStorage.getItem(STORAGE_KEY)).toBe("light");

    await act(() => result.current[1]());

    expect(result.current[0]).toBe("dark");
    expect(document.documentElement.dataset.theme).toBe("dark");
    expect(localStorage.getItem(STORAGE_KEY)).toBe("dark");
  });
});
