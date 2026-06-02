import { Link, Outlet } from "@tanstack/react-router";
import { useApp } from "../app-context.js";
import { CommandPalette } from "./CommandPalette.js";
import { SECTIONS } from "./sections.js";
import { useTheme } from "./use-theme.js";

const navItemBase = "rounded px-2 py-1.5 text-sm transition-colors";
const footBtn =
  "rounded px-2 py-1.5 text-left text-xs text-muted hover:bg-accent-wash hover:text-ink";

/** The inverted-L cockpit shell: a slim left section-nav and the active section pane. */
export function Shell() {
  const { logout } = useApp();
  const [theme, toggleTheme] = useTheme();

  return (
    <div className="grid h-dvh grid-cols-[208px_minmax(0,1fr)]">
      <nav className="flex flex-col gap-0.5 border-r border-line bg-sunk px-3 py-4">
        <div className="px-2 pb-4 font-mono text-sm font-semibold tracking-wide text-ink">
          Cogmo
        </div>
        {SECTIONS.map((section) => (
          <Link
            key={section.to}
            to={section.to}
            className={navItemBase}
            inactiveProps={{ className: "text-muted hover:bg-accent-wash hover:text-ink" }}
            activeProps={{ className: "bg-accent-wash font-medium text-accent-ink" }}
          >
            {section.label}
          </Link>
        ))}
        <div className="mt-auto flex flex-col gap-0.5 border-t border-line pt-3">
          <button type="button" className={footBtn} onClick={toggleTheme}>
            {theme === "dark" ? "Light mode" : "Dark mode"}
          </button>
          <button type="button" className={footBtn} onClick={() => void logout()}>
            Log out
          </button>
          <span className="px-2 pt-1 font-mono text-[11px] text-faint">⌘K to jump</span>
        </div>
      </nav>
      <main className="min-w-0 overflow-hidden">
        <Outlet />
      </main>
      <CommandPalette toggleTheme={toggleTheme} logout={logout} />
    </div>
  );
}
