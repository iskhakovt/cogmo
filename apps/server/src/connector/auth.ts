/**
 * The hub's cache of active connectors, keyed on token hash
 * (design/connectors.md → Wire contract → Auth). Ages are measured on the
 * monotonic clock, so a wall-clock step moves no deadline.
 */

import { err, ok, type Result } from "neverthrow";
import type { Transactor } from "../db/index.js";
import { logger } from "../logger.js";
import { finishesWithin } from "../util/finishes-within.js";
import type { ActiveConnector, ConnectorStore } from "./store/index.js";
import { hashConnectorToken } from "./token.js";

/** How often the hub reloads the cache. */
export const AUTH_REFRESH_MS = 30_000;

/** At most one refresh per this long for tokens the cache does not recognise. */
const UNKNOWN_TOKEN_REFRESH_MS = 5_000;

/** A cache not loaded for three refreshes in a row fails every call closed. */
const STALE_MS = 3 * AUTH_REFRESH_MS;

/** How long after a refresh starts a call still waits on it before answering `UNAVAILABLE`. */
const REFRESH_WAIT_MS = 5_000;

export type AuthError = { kind: "unauthenticated" } | { kind: "unavailable" };

export interface ConnectorAuthDeps {
  runInTx: Transactor;
  connectorStore: ConnectorStore;
}

export interface ConnectorAuthCache {
  /** The active connector `rawToken` belongs to. */
  authenticate(rawToken: string): Promise<Result<ActiveConnector, AuthError>>;
  /** Whether `connector` is still active under the token it authenticated with. */
  isCurrent(connector: ActiveConnector): boolean;
  /** Whether the last successful load is too old to trust, so revokes may be missing. */
  isStale(): boolean;
  /**
   * Reloads the cache from the table, or joins the reload in flight. Never
   * rejects: a failed read is logged and keeps the old cache.
   */
  refresh(): Promise<void>;
}

/** A reload in flight, and the one bounded wait every caller shares. */
interface Refresh {
  readonly done: Promise<void>;
  /** Resolves `true` once `done` settles, or `false` `REFRESH_WAIT_MS` after the reload started. */
  readonly waited: Promise<boolean>;
}

export class ConnectorAuth implements ConnectorAuthCache {
  readonly #deps: ConnectorAuthDeps;
  #byHash: ReadonlyMap<string, ActiveConnector> = new Map();
  #attemptedAt = Number.NEGATIVE_INFINITY;
  /** When the last successful load started. */
  #loadedAt = Number.NEGATIVE_INFINITY;
  #lastLoadFailed = false;
  #refreshing: Refresh | null = null;

  private constructor(deps: ConnectorAuthDeps) {
    this.#deps = deps;
  }

  /** Loads the active connectors; rejects when that first read fails. */
  static async create(deps: ConnectorAuthDeps): Promise<ConnectorAuth> {
    const auth = new ConnectorAuth(deps);
    await auth.#load();
    return auth;
  }

  async authenticate(rawToken: string): Promise<Result<ActiveConnector, AuthError>> {
    const tokenHash = hashConnectorToken(rawToken);
    if (!this.#byHash.has(tokenHash) || this.isStale()) {
      const throttled = performance.now() - this.#attemptedAt < UNKNOWN_TOKEN_REFRESH_MS;
      if (this.#refreshing === null && !throttled) void this.refresh();
      if (this.#refreshing !== null && !(await this.#refreshing.waited)) {
        return err({ kind: "unavailable" });
      }
    }
    if (this.isStale()) return err({ kind: "unavailable" });
    const found = this.#byHash.get(tokenHash);
    if (found) return ok(found);
    return err({ kind: this.#lastLoadFailed ? "unavailable" : "unauthenticated" });
  }

  isCurrent(connector: ActiveConnector): boolean {
    return this.#byHash.get(connector.tokenHash)?.id === connector.id;
  }

  isStale(): boolean {
    return performance.now() - this.#loadedAt >= STALE_MS;
  }

  refresh(): Promise<void> {
    if (this.#refreshing === null) {
      const done = this.#load()
        .catch((error: unknown) => {
          logger.warn({ err: error }, "connector auth: refreshing the connector cache failed");
        })
        .finally(() => {
          this.#refreshing = null;
        });
      this.#refreshing = { done, waited: finishesWithin(done, REFRESH_WAIT_MS) };
    }
    return this.#refreshing.done;
  }

  /** Loads the active connectors; rejects when the read fails. */
  async #load(): Promise<void> {
    const startedAt = performance.now();
    this.#attemptedAt = startedAt;
    const { runInTx, connectorStore } = this.#deps;
    try {
      const active = await runInTx((tx) => connectorStore.listActive(tx));
      this.#byHash = new Map(active.map((connector) => [connector.tokenHash, connector]));
      this.#loadedAt = startedAt;
      this.#lastLoadFailed = false;
    } catch (error) {
      this.#lastLoadFailed = true;
      throw error;
    }
  }
}
