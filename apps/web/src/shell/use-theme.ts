import { useState } from "react";

export type Theme = "dark" | "light";

// Mirrored by the pre-paint script in index.html — rename both together or the anti-flash drifts.
const STORAGE_KEY = "cogmo-theme";

/** Read the current theme, and toggle it — persisting to localStorage + the `data-theme` attribute. */
export function useTheme(): [Theme, () => void] {
  const [theme, setTheme] = useState<Theme>(() =>
    document.documentElement.dataset.theme === "light" ? "light" : "dark",
  );
  function toggle(): void {
    const next: Theme = theme === "dark" ? "light" : "dark";
    document.documentElement.dataset.theme = next;
    try {
      localStorage.setItem(STORAGE_KEY, next);
    } catch {
      // Private-mode / storage-disabled — the in-memory toggle still works.
    }
    setTheme(next);
  }
  return [theme, toggle];
}
