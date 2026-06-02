import type { ReactNode } from "react";
import type { ResourceState } from "./use-resource.js";

/** A full section pane: ruled header (title + "section" tag) over a scrolling body. */
export function Screen({ title, children }: { title: string; children: ReactNode }) {
  return (
    <section className="flex h-full flex-col">
      <header className="flex items-baseline gap-2 border-b border-line px-6 py-3">
        <h1 className="text-sm font-semibold text-ink">{title}</h1>
        <span className="font-mono text-[11px] uppercase tracking-[0.14em] text-faint">
          section
        </span>
      </header>
      <div className="min-h-0 flex-1 overflow-y-auto px-6 py-5">
        <div className="flex flex-col gap-8">{children}</div>
      </div>
    </section>
  );
}

/** A titled block within a screen (e.g. "Profiles", "MCP servers"). */
export function Panel({
  title,
  count,
  children,
}: {
  title: string;
  count?: number;
  children: ReactNode;
}) {
  return (
    <section className="flex flex-col gap-2">
      <div className="flex items-baseline gap-2">
        <h2 className="text-xs font-semibold uppercase tracking-[0.12em] text-muted">{title}</h2>
        {count !== undefined ? (
          <span className="font-mono text-[11px] text-faint">{count}</span>
        ) : null}
      </div>
      {children}
    </section>
  );
}

/** Render a resource's loading / inline-error / ready states; `children` gets the data. */
export function Resource<T>({
  state,
  children,
}: {
  state: ResourceState<T>;
  children: (data: T) => ReactNode;
}) {
  if (state.status === "loading") {
    return <p className="px-1 py-3 text-sm text-muted">Loading…</p>;
  }
  if (state.status === "error") {
    return (
      <p className="rounded border border-bad/40 bg-bad-wash px-3 py-2 font-mono text-xs text-bad">
        {state.message}
      </p>
    );
  }
  return <>{children(state.data)}</>;
}

/** A right-aligned drawer for detail views (e.g. an evolution event). */
export function Drawer({
  title,
  onClose,
  children,
}: {
  title: string;
  onClose: () => void;
  children: ReactNode;
}) {
  return (
    // biome-ignore lint/a11y/noStaticElementInteractions: backdrop click-to-dismiss; the Close button handles keyboard.
    // biome-ignore lint/a11y/useKeyWithClickEvents: keyboard dismiss is the Close button below.
    <div
      className="fixed inset-0 z-40 flex justify-end bg-black/40"
      onClick={(e) => {
        if (e.target === e.currentTarget) onClose();
      }}
    >
      <aside className="flex h-full w-full max-w-md flex-col border-l border-line-strong bg-surface">
        <header className="flex items-center justify-between border-b border-line px-5 py-3">
          <h2 className="font-mono text-sm text-ink">{title}</h2>
          <button
            type="button"
            onClick={onClose}
            className="rounded px-2 py-1 text-xs text-muted hover:bg-accent-wash hover:text-ink"
          >
            Close
          </button>
        </header>
        <div className="min-h-0 flex-1 overflow-y-auto px-5 py-4">{children}</div>
      </aside>
    </div>
  );
}

// --- Ledger table classes (hairline rules, mono data, 8px grid) ---
export const table = "w-full border-collapse text-sm";
export const th =
  "border-b border-line px-3 py-2 text-left text-[11px] font-medium uppercase tracking-[0.1em] text-faint";
export const td = "border-b border-line px-3 py-2 align-top text-ink";
export const tdMono = `${td} font-mono text-xs text-muted`;
export const trHover = "hover:bg-sunk";

/** An empty-state row spanning a table. */
export function EmptyRow({ colSpan, label }: { colSpan: number; label: string }) {
  return (
    <tr>
      <td colSpan={colSpan} className="px-3 py-6 text-center text-sm text-muted">
        {label}
      </td>
    </tr>
  );
}

/** A small status pill in the trust palette. */
export function Pill({
  tone,
  children,
}: {
  tone: "ok" | "warn" | "bad" | "muted";
  children: ReactNode;
}) {
  const cls =
    tone === "ok"
      ? "bg-ok-wash text-ok"
      : tone === "warn"
        ? "bg-warn-wash text-warn"
        : tone === "bad"
          ? "bg-bad-wash text-bad"
          : "bg-sunk text-muted";
  return (
    <span className={`inline-block rounded px-1.5 py-0.5 font-mono text-[10px] uppercase ${cls}`}>
      {children}
    </span>
  );
}

/** Format a `Date` (or null) as a compact local timestamp, or an em-dash. */
export function fmtDateTime(d: Date | null | undefined): string {
  if (!d) return "—";
  return new Date(d).toLocaleString(undefined, {
    year: "numeric",
    month: "short",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
  });
}
