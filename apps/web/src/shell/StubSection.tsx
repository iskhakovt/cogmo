/** Placeholder for a section whose screens land in a later slice. */
export function StubSection({ title, note }: { title: string; note: string }) {
  return (
    <section className="flex h-full flex-col">
      <header className="flex items-baseline gap-2 border-b border-line px-6 py-3">
        <h1 className="text-sm font-semibold text-ink">{title}</h1>
        <span className="font-mono text-[11px] uppercase tracking-[0.14em] text-faint">
          section
        </span>
      </header>
      <div className="flex flex-1 items-center justify-center px-6">
        <p className="max-w-md text-center text-sm text-muted">{note}</p>
      </div>
    </section>
  );
}
