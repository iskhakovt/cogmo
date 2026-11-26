/**
 * The container creates admitted on one task socket (design/sandbox.md →
 * Proxy Design → Child containers). A create is admitted once its checks
 * have passed and the child cap has room, in the same synchronous step as
 * the cap's count, and stays admitted until its child is recorded and the
 * client answered. While admitted it counts as a live child, so concurrent
 * creates cannot each land past the cap, and teardown waits for it, so a
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
}

export interface CreateTracker {
  /** What an admitted create's daemon request is bound to. */
  readonly signal: AbortSignal;
  /** The creates admitted and not yet settled, which the child cap counts as live. */
  readonly admitted: number;
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

export class InFlightCreates implements CreateTracker {
  #pending = new Set<Promise<void>>();
  #controller = new AbortController();
  #admitting = true;

  get signal(): AbortSignal {
    return this.#controller.signal;
  }

  get admitted(): number {
    return this.#pending.size;
  }

  admit(): Result<CreateAdmission, ProxyRejection> {
    if (!this.#admitting) return err(unavailable("the task is being torn down"));
    const { promise, resolve } = Promise.withResolvers<void>();
    this.#pending.add(promise);
    const end = () => {
      this.#pending.delete(promise);
      resolve();
    };
    return ok({
      run: (work) => {
        // A throw from `work` is a bug, which its caller logs.
        const ran = (async () => work())();
        ran.then(end, end);
        return ran;
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
      await Promise.race([Promise.allSettled([...this.#pending]), elapsed, aborted]);
    } finally {
      clearTimeout(timer);
      this.signal.removeEventListener("abort", onAbort);
    }
  }

  abort(reason: Error): void {
    this.#controller.abort(reason);
  }
}
