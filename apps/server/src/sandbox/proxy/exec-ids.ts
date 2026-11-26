/**
 * The exec ids a task's socket created (design/sandbox.md → Proxy Design →
 * Ownership): the only ids its exec routes accept. The set is capped, the
 * oldest id forgotten first, so a task that creates execs without end
 * cannot grow the proxy's memory without end.
 */

/** Past this many ids, the oldest is forgotten. */
const MAX_EXEC_IDS = 4096;

/** What the checks read: whether an exec id was created through this socket. */
export interface ExecIdLookup {
  has(execId: string): boolean;
}

export interface ExecIdRegistry extends ExecIdLookup {
  /** Record an id the daemon answered 201 with to an exec create sent through this socket. */
  add(execId: string): void;
}

export class ExecIds implements ExecIdRegistry {
  // A Set iterates in insertion order, so its first value is the oldest.
  #ids = new Set<string>();

  has(execId: string): boolean {
    return this.#ids.has(execId);
  }

  add(execId: string): void {
    this.#ids.add(execId);
    if (this.#ids.size <= MAX_EXEC_IDS) return;
    const oldest = this.#ids.values().next();
    if (!oldest.done) this.#ids.delete(oldest.value);
  }
}
