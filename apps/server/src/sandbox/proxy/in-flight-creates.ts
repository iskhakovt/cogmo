/**
 * The container creates in flight on one task socket, from the request's
 * classification to its child's row and the answer (design/sandbox.md →
 * Proxy Design → Child containers). Teardown waits for them before the
 * cascade lists the task's rows, so a child the daemon has created gets
 * its row in time to be reaped with the rest.
 *
 * Their daemon requests are bound to `signal`, which teardown aborts only
 * once it has waited: never to the client's connection, nor to the
 * signal that ends the task's connections.
 */
export interface CreateTracker {
  /** What a create's daemon request is bound to. */
  readonly signal: AbortSignal;
  /** Track `work`, which settles once the create is answered and never rejects. */
  track(work: Promise<void>): void;
  /** Resolves once every create tracked so far has settled, or after `ms`, whichever is first. */
  settled(ms: number): Promise<void>;
  /** Abort every create still in flight, and any tracked later. */
  abort(reason: Error): void;
}

export class InFlightCreates implements CreateTracker {
  #pending = new Set<Promise<void>>();
  #controller = new AbortController();

  get signal(): AbortSignal {
    return this.#controller.signal;
  }

  track(work: Promise<void>): void {
    const tracked = work.finally(() => this.#pending.delete(tracked));
    this.#pending.add(tracked);
  }

  async settled(ms: number): Promise<void> {
    if (this.#pending.size === 0) return;
    let timer: ReturnType<typeof setTimeout> | undefined;
    const elapsed = new Promise<void>((resolve) => {
      timer = setTimeout(resolve, ms);
    });
    try {
      await Promise.race([Promise.allSettled([...this.#pending]), elapsed]);
    } finally {
      clearTimeout(timer);
    }
  }

  abort(reason: Error): void {
    this.#controller.abort(reason);
  }
}
