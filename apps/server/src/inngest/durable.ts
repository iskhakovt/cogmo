/**
 * The durable-execution port the domain plans its work through, and the one
 * adapter that maps Inngest's `step` onto it.
 *
 * Orchestration is Inngest (design/architecture.md → Orchestration Coupling):
 * functions are defined with `inngest.createFunction` in the domain module
 * that owns them, as thin controllers. A controller calls `fromStepTools(step)`
 * once and hands the resulting `Durable` to its use cases, which see only the
 * four primitives they use, typed against the events this project defines in
 * `events.ts`. Replay semantics are Inngest's and are not abstracted:
 * `.agents/rules/inngest.md` applies to every call through this port.
 */

import type { EventType, GetStepTools, StandardSchemaV1 } from "inngest";
import type { inngest } from "./client.js";
import type * as events from "./events.js";

type Definitions = typeof events;

/** Every `eventType` exported from `events.ts`; the other exports map to `never`. */
type DefinedEventType = {
  [K in keyof Definitions]: Definitions[K] extends EventType<string, infer S>
    ? S extends StandardSchemaV1
      ? Definitions[K]
      : never
    : never;
}[keyof Definitions];

/** The payload of one event type, as `eventType(...).create()` takes it. */
type EventData<E> =
  E extends EventType<string, infer S>
    ? S extends StandardSchemaV1
      ? StandardSchemaV1.InferInput<S>
      : never
    : never;

/** One event as an emitter hands it to Inngest: `create()`'s output, plus an optional dedup `id`. */
type EmittedEvent<E> =
  E extends EventType<infer N, infer _S>
    ? { name: N; data: EventData<E>; id?: string; ts?: number }
    : never;

/**
 * Any event this project defines and may emit: one variant per `eventType` in
 * `events.ts`, discriminated by `name`. Inngest's own system events
 * (`inngest/…`) are subscribed to, never emitted.
 */
export type DefinedEvent = Exclude<EmittedEvent<DefinedEventType>, { name: `inngest/${string}` }>;

/** One event or a batch, as `send` and `sendEvent` take them. */
type EventBatch = DefinedEvent | DefinedEvent[];

/**
 * Publishes events outside any step: the part of the Inngest client a deps bag
 * needs when it only emits. Inside a function, emit with `Durable.sendEvent`,
 * which is memoized per step id; `send` is not, so it re-fires on every replay.
 */
export interface EventPublisher {
  send(events: EventBatch): Promise<unknown>;
}

/** Values JSON does not carry unchanged: a `Date` becomes a string, a `bigint` throws, the rest are dropped or become `{}`. */
type Unserializable =
  | Date
  | Error
  | Map<unknown, unknown>
  | Set<unknown>
  | Uint8Array
  | bigint
  | symbol
  | ((...args: never[]) => unknown);

type JsonSafeValue<T> = T extends Unserializable
  ? never
  : T extends ReadonlyArray<infer E>
    ? ReadonlyArray<JsonSafeValue<E>>
    : T extends object
      ? { [K in keyof T]: JsonSafeValue<T[K]> }
      : T;

/**
 * `T` itself, or a type `T` does not satisfy where the JSON round-trip would
 * change it: a `Date`, an `Error`, a `Map` or a class with methods anywhere in
 * `T`, or `undefined` as one arm of a top-level union (a replay returns `null`
 * for it), fails `run` at the call site. A result that is only `undefined` or
 * `void` passes: nothing reads it. What it can't see passes too: `unknown`
 * and `any` (including an explicit `run<unknown>`), `undefined` inside an
 * array (it comes back `null`), and a class instance's prototype;
 * design/crash-recovery.md → State serialization owns the rule for those.
 */
type JsonSafe<T> = [T] extends [undefined] ? T : T extends undefined ? never : JsonSafeValue<T>;

/** A duration Inngest's `step.sleep` accepts, in its whole-unit string form. */
type Duration = `${number}${"ms" | "s" | "m" | "h" | "d" | "w"}`;

/** The event `waitForEvent` resolves with: what the matching emitter sent, as Inngest delivers it. */
interface ReceivedEvent<E> {
  name: E extends EventType<infer N, infer _S> ? N : never;
  data: E extends EventType<string, infer S>
    ? S extends StandardSchemaV1
      ? StandardSchemaV1.InferOutput<S>
      : never
    : never;
  id: string;
  ts: number;
}

interface WaitForEventOptions<E> {
  event: E;
  timeout: Duration;
  /** An Inngest expression over `event` (the trigger) and `async` (the candidate). */
  if: string;
}

/**
 * The durable steps a use case plans. Every method is keyed by a step id the
 * caller derives from durable state (`.agents/rules/inngest.md`).
 */
export interface Durable {
  /**
   * Run `body` once per run and memoize its result under `id`; a replay
   * returns the memoized value without running the body. Errors propagate
   * unchanged: a step that exhausted its retries rejects with Inngest's
   * `StepError` on every later invocation.
   */
  run<T>(id: string, body: () => Promise<T & JsonSafe<T>>): Promise<T>;
  /** Emit one event or a batch, once per run for each `id`. */
  sendEvent(id: string, events: EventBatch): Promise<void>;
  /** Suspend the run for `duration`, at Inngest's one-second resolution. */
  sleep(id: string, duration: Duration): Promise<void>;
  /** Suspend until a matching `event` arrives, or `timeout` passes (`null`). */
  waitForEvent<E extends DefinedEventType>(
    id: string,
    options: WaitForEventOptions<E>,
  ): Promise<ReceivedEvent<E> | null>;
}

/** The parts of an Inngest handler's `step` the adapter maps. */
type InngestStep = Pick<
  GetStepTools<typeof inngest>,
  "run" | "sendEvent" | "sleep" | "waitForEvent"
>;

/**
 * Map an Inngest handler's `step` onto the port. Each method forwards to the
 * matching step tool when called, and `run` returns the step tool's own
 * promise, so step ids, their order, retries and rejections are Inngest's.
 */
export function fromStepTools(step: InngestStep): Durable {
  return {
    // Inngest types a step result as `Jsonify<T>`, what `T` becomes after the
    // JSON round-trip through its state store. `run`'s `JsonSafe<T>` check
    // rejects the shapes that round-trip changes, so for a `T` that passes it
    // the two coincide, up to the cases `JsonSafe` lists as unseen; the cast
    // restates that for a compiler that can't relate `Jsonify<T>` to an
    // unresolved `T`.
    run: <T>(id: string, body: () => Promise<T & JsonSafe<T>>) => step.run(id, body) as Promise<T>,
    sendEvent: async (id, batch) => {
      await step.sendEvent(id, batch);
    },
    sleep: (id, duration) => step.sleep(id, duration),
    // Inngest's `WaitForEventResult` is a conditional over the options type,
    // which the compiler can't resolve while `E` is a type parameter; for a
    // `DefinedEventType` it resolves to `ReceivedEvent<E> | null`.
    waitForEvent: <E extends DefinedEventType>(id: string, options: WaitForEventOptions<E>) =>
      step.waitForEvent(id, options) as Promise<ReceivedEvent<E> | null>,
  };
}
