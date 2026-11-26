/**
 * The container creates admitted on one task socket (design/sandbox.md →
 * Proxy Design → Child containers). A create is admitted once its checks
 * have passed and the child cap has room, in the same synchronous step as
 * the cap's count, and stays admitted until its child is recorded and the
 * client answered. While admitted it counts as a live child, until a store
 * read returns its child's row, which counts in its place, so concurrent
 * creates cannot each land past the cap; and teardown waits for it, so a
 * child the daemon has created gets its row before the cascade lists the
 * task's rows. A create still reading its body or running its checks is
 * not admitted yet, and holds nothing up.
 *
 * Admitted creates' daemon requests are bound to `signal`, which teardown
 * aborts only once it has waited: never to the client's connection, nor to
 * the signal that ends the task's connections.
 */

import { err, ok, type Result } from "neverthrow";
import { type ProxyRejection, unavailable } from "./rejection.js";

/** One admitted create. */
export interface CreateAdmission {
  /** Run the create; the admission ends once `work` settles, whether it resolves or rejects. */
  run(work: () => Promise<void>): Promise<void>;
  /** Name the child the daemon created, whose row then counts in the admission's place. */
  named(dockerId: string): void;
}

export interface CreateTracker {
  /** What an admitted create's daemon request is bound to. */
  readonly signal: AbortSignal;
  /**
   * The creates admitted and not yet settled whose child is not among
   * `counted`, the docker ids of the rows the cap already counts.
   */
  admittedBeyond(counted: ReadonlySet<string>): number;
  /** Admit a create whose checks passed; `unavailable` once teardown has begun. */
  admit(): Result<CreateAdmission, ProxyRejection>;
  /** Admit no more creates: teardown has begun. */
  stopAdmitting(): void;
  /**
   * Resolves once every create admitted so far has settled, after `ms`, or
   * once the creates are aborted, whichever is first.
   */
  settled(ms: number): Promise<void>;
  /** Abort every create still in flight, and end any wait for them. */
  abort(reason: Error): void;
}

interface Admitted {
  readonly settled: Promise<void>;
  dockerId: string | null;
}

export class InFlightCreates implements CreateTracker {
  #pending = new Set<Admitted>();
  #controller = new AbortController();
  #admitting = true;

  get signal(): AbortSignal {
    return this.#controller.signal;
  }

  admittedBeyond(counted: ReadonlySet<string>): number {
    return [...this.#pending].filter(
      (entry) => entry.dockerId === null || !counted.has(entry.dockerId),
    ).length;
  }

  admit(): Result<CreateAdmission, ProxyRejection> {
    if (!this.#admitting) return err(unavailable("the task is being torn down"));
    const { promise, resolve } = Promise.withResolvers<void>();
    const entry: Admitted = { settled: promise, dockerId: null };
    this.#pending.add(entry);
    const end = () => {
      this.#pending.delete(entry);
      resolve();
    };
    return ok({
      run: (work) => {
        // A throw from `work` is a bug, which its caller logs.
        const ran = (async () => work())();
        ran.then(end, end);
        return ran;
      },
      named: (dockerId) => {
        entry.dockerId = dockerId;
      },
    });
  }

  stopAdmitting(): void {
    this.#admitting = false;
  }

  async settled(ms: number): Promise<void> {
    if (this.#pending.size === 0 || this.signal.aborted) return;
    let timer: ReturnType<typeof setTimeout> | undefined;
    let onAbort = () => {};
    const elapsed = new Promise<void>((resolve) => {
      timer = setTimeout(resolve, ms);
    });
    const aborted = new Promise<void>((resolve) => {
      onAbort = () => resolve();
      this.signal.addEventListener("abort", onAbort, { once: true });
    });
    try {
      const admitted = [...this.#pending].map((entry) => entry.settled);
      await Promise.race([Promise.all(admitted), elapsed, aborted]);
    } finally {
      clearTimeout(timer);
      this.signal.removeEventListener("abort", onAbort);
    }
  }

  abort(reason: Error): void {
    this.#controller.abort(reason);
  }
}
