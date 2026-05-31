/**
 * Stateful Daytona snapshot pipeline fake for unit tests of
 * `DaytonaSandboxClient`. Layers on top of the flat `vi.fn()` SDK
 * mocks in `client.test.ts`'s `daytonaCalls` registry to model the
 * async lifecycle semantics that the flat mocks structurally can't:
 *
 *   - `snapshot.delete` returns 2xx immediately and the row enters
 *     `REMOVING`; it drains to absent over time, not synchronously.
 *   - `snapshot.create({ name })` against an in-flight or `REMOVING`
 *     row 409s with `DaytonaConflictError` (the original bug class).
 *   - `snapshot.get(name)` over a polling window can observe a state
 *     transition (e.g. `BUILDING` → `ACTIVE`, `REMOVING` → absent)
 *     after N observations.
 *
 * Flat `vi.fn().mockResolvedValue(...)` setups can't represent these
 * because they're stateless. The fake holds per-snapshot state and
 * transitions it on the same calls the SUT makes, so tests model real
 * Daytona behavior instead of an idealised happy path.
 *
 * Mocks keep their `vi.fn()` identity after binding so `.mock.calls`
 * introspection still works — the fake only installs implementations.
 *
 * Usage:
 *
 * ```ts
 * const pipeline = new FakeDaytonaSnapshotPipeline()
 *   .setState("my-snap", "build_failed")
 *   .bindTo(daytonaCalls);
 *
 * await client.ensureImagePresent("my-image:1.0");
 *
 * expect(pipeline.attempts("my-snap")).toBe(1);
 * ```
 */

import { DaytonaConflictError, DaytonaNotFoundError } from "@daytonaio/sdk";
import { expect, type Mock } from "vitest";

/**
 * Snapshot lifecycle states the fake models. `"absent"` means the
 * row doesn't exist on the provider side — `get` returns
 * `DaytonaNotFoundError`. The rest match Daytona's `SnapshotState`
 * enum literal-for-literal so the SUT's state-machine reads them
 * identically to real Daytona payloads.
 */
export type FakeSnapshotState =
  | "absent"
  | "active"
  | "building"
  | "pending"
  | "pulling"
  | "inactive"
  | "error"
  | "build_failed"
  | "removing";

/** States a `snapshot.create({ name })` against the same name 409s on. */
const CONFLICT_STATES: ReadonlySet<FakeSnapshotState> = new Set<FakeSnapshotState>([
  "removing",
  "building",
  "pending",
  "pulling",
  "active",
]);

interface PendingTransition {
  /** Decremented on each `get()` that observes the current state; flips at 0. */
  countdown: number;
  next: FakeSnapshotState;
}

interface Entry {
  state: FakeSnapshotState;
  transition?: PendingTransition;
}

/**
 * Implementation of one `snapshot.create({ name, image })` call. Default
 * sets the snapshot to `"active"` and returns. Custom behaviors can
 * throw to model errors, or stage transient errors that succeed on a
 * later attempt by inspecting the per-name `attempt` counter.
 */
export type CreateBehavior = (
  name: string,
  image: string,
  attempt: number,
  ctx: { setState: (state: FakeSnapshotState) => void },
) => void | Promise<void>;

export class FakeDaytonaSnapshotPipeline {
  #entries = new Map<string, Entry>();
  #createAttempts = new Map<string, number>();
  #createBehavior: CreateBehavior;

  constructor() {
    this.#createBehavior = (_name, _image, _attempt, { setState }) => {
      setState("active");
    };
  }

  // ── Configuration ───────────────────────────────────────────────────

  /**
   * Place a snapshot in `state`. Calling `setState("foo", "absent")`
   * is equivalent to "row doesn't exist on the provider".
   */
  setState(name: string, state: FakeSnapshotState): this {
    const existing = this.#entries.get(name);
    const entry: Entry = existing?.transition
      ? { state, transition: existing.transition }
      : { state };
    this.#entries.set(name, entry);
    return this;
  }

  /**
   * After `afterGets` more `snapshot.get(name)` calls have observed
   * the current state, transition to `to`. Models async drains —
   * `REMOVING` → `absent` (Daytona's reaper completes), `BUILDING` →
   * `ACTIVE` (build finishes during a poll window), etc.
   */
  scheduleTransition(name: string, opts: { afterGets: number; to: FakeSnapshotState }): this {
    const existing = this.#entries.get(name);
    if (!existing) {
      throw new Error(`scheduleTransition: ${name} has no current state — call setState first`);
    }
    this.#entries.set(name, {
      state: existing.state,
      transition: { countdown: opts.afterGets, next: opts.to },
    });
    return this;
  }

  /**
   * Override what `snapshot.create({ name, image })` does. Useful for
   * modeling transient errors that clear on retry, persistent errors,
   * or attempt-aware behavior. The default implementation sets the
   * snapshot to `"active"` and returns.
   */
  setCreateBehavior(fn: CreateBehavior): this {
    this.#createBehavior = fn;
    return this;
  }

  // ── Inspection ──────────────────────────────────────────────────────

  state(name: string): FakeSnapshotState {
    return this.#entries.get(name)?.state ?? "absent";
  }

  attempts(name: string): number {
    return this.#createAttempts.get(name) ?? 0;
  }

  /** All names the SUT has called `snapshot.create` against. */
  createdNames(): ReadonlyArray<string> {
    return [...this.#createAttempts.keys()];
  }

  // ── Wire-up ─────────────────────────────────────────────────────────

  /**
   * Install implementations on the existing `vi.fn()` mocks. Mocks
   * keep their identity so `.mock.calls` introspection from tests
   * still works — only the behavior is wired through this fake.
   */
  bindTo(mocks: { snapshotGet: Mock; snapshotCreate: Mock; snapshotDelete: Mock }): this {
    mocks.snapshotGet.mockImplementation(async (name: string) => {
      const entry = this.#entries.get(name);
      const state = entry?.state ?? "absent";
      // Apply any pending transition AFTER the caller observes the
      // current state. Countdown semantics: `afterGets: 0` flips on
      // the very next observation; `afterGets: 1` flips on the one
      // after that.
      if (entry?.transition) {
        if (entry.transition.countdown <= 0) {
          this.#entries.set(name, { state: entry.transition.next });
        } else {
          this.#entries.set(name, {
            state: entry.state,
            transition: {
              countdown: entry.transition.countdown - 1,
              next: entry.transition.next,
            },
          });
        }
      }
      if (state === "absent") {
        throw new DaytonaNotFoundError(`snapshot ${name} not found`);
      }
      // Shape matches Daytona's `Snapshot` enough for the client — it
      // reads only `name` and `state`.
      return { name, state };
    });

    mocks.snapshotCreate.mockImplementation(async (arg: { name: string; image: string }) => {
      const { name, image } = arg;
      const current = this.state(name);
      if (CONFLICT_STATES.has(current)) {
        // Models Daytona's 409 on create-against-existing-name. The
        // `REMOVING` case is the load-bearing one for the
        // rename-on-rebuild path: a same-name recreate after delete
        // hits this because the row hasn't drained yet.
        throw new DaytonaConflictError(
          `Snapshot with name "${name}" already exists for this organization`,
        );
      }
      const attempt = (this.#createAttempts.get(name) ?? 0) + 1;
      this.#createAttempts.set(name, attempt);
      await this.#createBehavior(name, image, attempt, {
        setState: (s) => this.setState(name, s),
      });
      return { name, state: this.state(name) };
    });

    mocks.snapshotDelete.mockImplementation(async (snapshot: { name: string; state: string }) => {
      // Daytona returns 2xx immediately and the row enters REMOVING.
      // Tests model the drain via `scheduleTransition(..., to: "absent")`;
      // a test that doesn't schedule a drain models a stuck reaper.
      this.setState(snapshot.name, "removing");
    });

    return this;
  }
}

/**
 * Convenience: assert that the SUT only ever called `snapshot.create`
 * with names matching one of the supplied patterns. Catches accidental
 * dispatches against stale names — the original bug shape this fake
 * was built to expose.
 */
export function expectCreatedNamesMatch(
  pipeline: FakeDaytonaSnapshotPipeline,
  patterns: ReadonlyArray<RegExp>,
): void {
  for (const name of pipeline.createdNames()) {
    const matched = patterns.some((p) => p.test(name));
    if (!matched) {
      expect.fail(
        `snapshot.create was called with unexpected name "${name}" — patterns: ${patterns.map((p) => p.toString()).join(", ")}`,
      );
    }
  }
}
