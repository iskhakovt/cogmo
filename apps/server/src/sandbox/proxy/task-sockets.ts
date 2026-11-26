/**
 * The proxy's per-task Unix sockets (design/sandbox.md → Proxy Design →
 * Teardown order): one registration per task, each on a path of its own,
 * `<task-id>-<generation>.sock`, the generation a counter this process
 * keeps. A registration of a task after its unregister gets a new path,
 * since closing a listener unlinks its path, and an old registration's
 * close must not unlink a new one's file. An upsert of a live registration
 * keeps its path, and an anchor update reaches only a live registration:
 * a task torn down meanwhile gets no new socket that nothing would mount.
 *
 * A socket serves its scope until its teardown begins, and from then on its
 * connections are `unavailable`, whatever registration the task has since.
 * This module owns the sockets' lifecycle and never touches the HTTP
 * server: each accepted connection goes to `onConnection`.
 */

import { rm } from "node:fs/promises";
import * as net from "node:net";
import { join } from "node:path";
import { addAbortSignal } from "node:stream";
import { err, ok, type Result } from "neverthrow";
import * as R from "remeda";
import { match, P } from "ts-pattern";
import { logger } from "../../logger.js";
import { type ExecIdRegistry, ExecIds } from "./exec-ids.js";
import { type CreateTracker, InFlightCreates } from "./in-flight-creates.js";
import type { TaskAnchor, TaskScope } from "./types.js";

const log = logger.child({ component: "sandbox.proxy" });

/**
 * How long a teardown waits for a task's admitted creates before it aborts
 * them: long enough for the daemon to answer a create and the row insert to
 * land, so the cascade finds the child.
 */
const CREATES_SETTLE_MS = 30_000;

/** A socket that serves its scope, or one whose teardown has begun. */
export type TaskSocketState = { kind: "serving"; scope: TaskScope } | { kind: "retiring" };

/** A task's socket, as the connections it accepted see it. */
export interface TaskSocket {
  readonly taskId: string;
  readonly socketPath: string;
  readonly state: TaskSocketState;
  /**
   * Aborts at the end of the socket's teardown, or at once on `closeAll`:
   * every connection the socket accepted, and every upstream connection
   * opened for one, is bound to it, but an admitted create's.
   */
  readonly signal: AbortSignal;
  /**
   * The exec ids the daemon answered 201 with to an exec create sent
   * through the socket: the only ids its exec routes accept. Shared by its
   * connections and capped (`exec-ids.ts`); it lives as long as the socket,
   * and a process restart loses it with the containers.
   */
  readonly execIds: ExecIdRegistry;
  /** The container creates admitted on the socket. */
  readonly creates: CreateTracker;
}

interface Registration extends TaskSocket {
  state: TaskSocketState;
  readonly controller: AbortController;
  /** Resolves once the listener is bound; rejects if binding failed. */
  readonly listening: Promise<net.Server>;
}

/** The task has no live registration: it was never registered, or is being torn down. */
export interface NotServing {
  kind: "not_serving";
}

export interface TaskSocketRegistry {
  /**
   * Upsert a task's scope, binding a socket of its own for a task with no
   * live registration; a live one keeps its anchor unless `scope` names one.
   */
  register(scope: TaskScope): Promise<string>;
  /**
   * Set the anchor of the task's live registration, the one `register`
   * answered `socketPath` for; `not_serving` when it has none, or another.
   */
  anchor(taskId: string, socketPath: string, anchor: TaskAnchor): Result<void, NotServing>;
  /** Tear the task's live registration down in the teardown order, joining a teardown under way. */
  unregister(taskId: string): Promise<void>;
  /** The creates admitted on any of the task's sockets whose child is not among `counted`. */
  admittedBeyond(taskId: string, counted: ReadonlySet<string>): number;
  /** Tear every socket down at once; a second call resolves with the first. */
  closeAll(): Promise<void>;
}

export interface TaskSocketsOptions {
  socketDir: string;
  /** Takes each connection a task socket accepts, already bound to its signal. */
  onConnection(socket: net.Socket, task: TaskSocket): void;
}

export class TaskSockets implements TaskSocketRegistry {
  #socketDir: string;
  #onConnection: (socket: net.Socket, task: TaskSocket) => void;
  /**
   * The serving registration of each task. Set before the listener binds,
   * so an `unregister` or `closeAll` racing `register` finds it.
   */
  #tasks = new Map<string, Registration>();
  /** Registrations being torn down, with each teardown, which `closeAll` aborts and awaits. */
  #retiring = new Map<Registration, Promise<void>>();
  /**
   * Each task's teardowns in progress, which an `unregister` for the task
   * joins, so its caller's cascade too waits for the creates admitted.
   */
  #unregistering = new Map<string, Promise<void>>();
  #generation = 0;
  #state: { kind: "open" } | { kind: "closing"; done: Promise<void> } = { kind: "open" };

  constructor(opts: TaskSocketsOptions) {
    this.#socketDir = opts.socketDir;
    this.#onConnection = opts.onConnection;
  }

  /**
   * Upsert a task's scope. A task with no serving registration gets a new
   * socket, bound before this resolves; one with a serving registration has
   * its scope replaced, so connections in flight see the update, and keeps
   * its path, and its anchor unless `scope` names one. Rejects if the socket
   * can't be bound, and when `unregister` or `closeAll` runs before the bind
   * completes.
   */
  async register(scope: TaskScope): Promise<string> {
    match(this.#state)
      .with({ kind: "open" }, () => undefined)
      .with({ kind: "closing" }, () => {
        throw new Error("proxy is closed");
      })
      .exhaustive();
    const { taskId } = scope;
    const task = this.#tasks.get(taskId) ?? this.#open(scope);
    task.state = { kind: "serving", scope: keepingAnchor(task.state, scope) };
    try {
      await task.listening;
    } catch (err) {
      if (this.#tasks.get(taskId) === task) this.#tasks.delete(taskId);
      throw err;
    }
    // A close or an unregister during the bind owns the task's teardown;
    // the socket is not usable.
    task.signal.throwIfAborted();
    return servedPath(task);
  }

  /**
   * Set the anchor of the task's serving registration, keeping its path.
   * `not_serving` when that registration was torn down meanwhile, whether
   * or not the task registered again since: no socket is opened for it,
   * since nothing would mount or unregister one, and a newer registration
   * belongs to another caller's container.
   */
  anchor(taskId: string, socketPath: string, anchor: TaskAnchor): Result<void, NotServing> {
    const task = this.#tasks.get(taskId);
    if (task === undefined || task.socketPath !== socketPath) return err({ kind: "not_serving" });
    return match(task.state)
      .with({ kind: "serving" }, ({ scope }): Result<void, NotServing> => {
        task.state = { kind: "serving", scope: { ...scope, anchor } };
        return ok(undefined);
      })
      .with({ kind: "retiring" }, () => err({ kind: "not_serving" as const }))
      .exhaustive();
  }

  admittedBeyond(taskId: string, counted: ReadonlySet<string>): number {
    const serving = this.#tasks.get(taskId);
    const retiring = [...this.#retiring.keys()].filter((task) => task.taskId === taskId);
    const registrations = serving === undefined ? retiring : [serving, ...retiring];
    return R.sumBy(registrations, (task) => task.creates.admittedBeyond(counted));
  }

  /**
   * Tear down the task's serving registration in the teardown order: the
   * creates admitted on it have settled, or 30 seconds have passed, before
   * this resolves. A call for a task already being torn down joins that
   * teardown, and resolves with it. Idempotent.
   */
  unregister(taskId: string): Promise<void> {
    const task = this.#tasks.get(taskId);
    if (task === undefined) return this.#unregistering.get(taskId) ?? Promise.resolve();
    this.#tasks.delete(taskId);
    return this.#joinTeardown(taskId, this.#retire(task, CREATES_SETTLE_MS));
  }

  /**
   * Tear every socket down at once: every create in flight is aborted, with
   * no wait for it, a teardown already waiting included. Each teardown has
   * finished before this resolves, an `unregister` meanwhile joins them, and
   * a second call resolves with the first.
   */
  closeAll(): Promise<void> {
    return match(this.#state)
      .with({ kind: "closing" }, ({ done }) => done)
      .with({ kind: "open" }, () => {
        const done = this.#closeEverySocket();
        this.#state = { kind: "closing", done };
        return done;
      })
      .exhaustive();
  }

  async #closeEverySocket(): Promise<void> {
    const closed = new Error("proxy is closed");
    const serving = [...this.#tasks.values()];
    this.#tasks.clear();
    for (const task of [...serving, ...this.#retiring.keys()]) abortTask(task, closed);
    for (const task of serving) this.#joinTeardown(task.taskId, this.#retire(task, 0));
    await Promise.all([...this.#retiring.values(), ...this.#unregistering.values()]);
  }

  #joinTeardown(taskId: string, torn: Promise<void>): Promise<void> {
    const pending = this.#unregistering.get(taskId);
    const teardown =
      pending === undefined ? torn : Promise.all([pending, torn]).then(() => undefined);
    this.#unregistering.set(taskId, teardown);
    const forget = () => {
      if (this.#unregistering.get(taskId) === teardown) this.#unregistering.delete(taskId);
    };
    teardown.then(forget, forget);
    return teardown;
  }

  /**
   * One registration's teardown: it stops serving and admits no more
   * creates; stops accepting; waits up to `settleMs` for the creates
   * admitted; then ends every connection, and any create still in flight
   * with them.
   */
  #retire(task: Registration, settleMs: number): Promise<void> {
    task.state = { kind: "retiring" };
    task.creates.stopAdmitting();
    const torn = (async () => {
      const server = await task.listening.catch(() => null);
      const listenerClosed =
        server === null
          ? Promise.resolve()
          : new Promise<void>((resolve) => server.close(() => resolve()));
      await task.creates.settled(settleMs);
      abortTask(task, new Error("task socket unregistered"));
      await listenerClosed;
      await rm(task.socketPath, { force: true });
    })();
    this.#retiring.set(task, torn);
    const forget = () => this.#retiring.delete(task);
    torn.then(forget, forget);
    return torn;
  }

  #open(scope: TaskScope): Registration {
    const { taskId } = scope;
    this.#generation += 1;
    const socketPath = join(this.#socketDir, `${taskId}-${this.#generation}.sock`);
    const controller = new AbortController();
    const { signal } = controller;
    // Half-open, as an HTTP server's own sockets are, for upgrades: a client
    // that ends its side after sending stdin (`echo hi | docker exec -i`)
    // still reads the daemon's output, and one that ends its side once its
    // upgrade request is complete still gets the answer. A connection Node's
    // HTTP server still owns, an ordinary request's or an upgrade's whose
    // body is still arriving, is ended by Node when the client ends its
    // side, and an answer still owed is dropped. The listener accepts
    // nothing before it is bound, by which time `task` is.
    const server = net.createServer({ allowHalfOpen: true }, (socket) => {
      // Destroys the socket at once if it was accepted after the abort.
      addAbortSignal(signal, socket);
      this.#onConnection(socket, task);
    });
    server.on("error", (err) => log.warn({ err: err.message, taskId }, "task socket error"));
    const listening = (async () => {
      // A file a crashed process left under this path.
      await rm(socketPath, { force: true });
      await new Promise<void>((resolve, reject) => {
        server.once("error", reject);
        server.listen(socketPath, () => {
          server.removeListener("error", reject);
          resolve();
        });
      });
      log.info({ taskId, socketPath }, "registered task proxy socket");
      return server;
    })();
    const task: Registration = {
      taskId,
      socketPath,
      state: { kind: "serving", scope },
      signal,
      controller,
      listening,
      execIds: new ExecIds(),
      creates: new InFlightCreates(),
    };
    this.#tasks.set(taskId, task);
    return task;
  }
}

/** The path of a registration still serving once its bind is done. */
function servedPath(task: Registration): string {
  return match(task.state)
    .with({ kind: "serving" }, () => task.socketPath)
    .with({ kind: "retiring" }, () => {
      throw new Error("task socket unregistered");
    })
    .exhaustive();
}

/** `scope`, with the anchor a serving registration already has when `scope` names none. */
function keepingAnchor(state: TaskSocketState, scope: TaskScope): TaskScope {
  return match([state, scope.anchor])
    .with([{ kind: "serving" }, null], ([serving]) => ({ ...scope, anchor: serving.scope.anchor }))
    .with([{ kind: "serving" }, P.nonNullable], () => scope)
    .with([{ kind: "retiring" }, P._], () => scope)
    .exhaustive();
}

/** End every connection of a registration, and the creates in flight on it. A second abort is a no-op. */
function abortTask(task: Registration, reason: Error): void {
  task.controller.abort(reason);
  task.creates.abort(reason);
}
