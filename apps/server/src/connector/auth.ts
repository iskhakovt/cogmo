/**
 * The hub's cache of active connectors, keyed on token hash
 * (design/connectors.md → Wire contract → Auth).
 */

import { err, ok, type Result } from "neverthrow";
import type { Transactor } from "../db/index.js";
import { logger } from "../logger.js";
import { finishesWithin } from "../util/finishes-within.js";
import type { ActiveConnector, ConnectorStore } from "./store/index.js";
import { hashConnectorToken } from "./token.js";

/** At most one refresh per this long for tokens the cache does not recognise. */
const UNKNOWN_TOKEN_REFRESH_MS = 5_000;

/** A cache not loaded for this long, three refreshes in a row, fails every call closed. */
const STALE_MS = 90_000;

/** How long a call waits on a refresh before answering `UNAVAILABLE`. */
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
   * Reloads the cache from the table, or joins the reload in flight. Resolves
   * `false`, logged, when the read fails, keeping the old cache.
   */
  refresh(): Promise<boolean>;
}

export class ConnectorAuth implements ConnectorAuthCache {
  readonly #deps: ConnectorAuthDeps;
  #byHash = new Map<string, ActiveConnector>();
  #attemptedAt = Number.NEGATIVE_INFINITY;
  /** When the last successful load started. */
  #loadedAt = Number.NEGATIVE_INFINITY;
  #lastLoadFailed = false;
  #refreshing: Promise<boolean> | null = null;

  private constructor(deps: ConnectorAuthDeps) {
    this.#deps = deps;
  }

  static async create(deps: ConnectorAuthDeps): Promise<ConnectorAuth> {
    const auth = new ConnectorAuth(deps);
    await auth.#load();
    return auth;
  }

  async authenticate(rawToken: string): Promise<Result<ActiveConnector, AuthError>> {
    const tokenHash = hashConnectorToken(rawToken);
    if (!this.#byHash.has(tokenHash) || this.isStale()) {
      const throttled = Date.now() - this.#attemptedAt < UNKNOWN_TOKEN_REFRESH_MS;
      const refresh = this.#refreshing ?? (throttled ? null : this.refresh());
      if (refresh && !(await finishesWithin(refresh, REFRESH_WAIT_MS))) {
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
    return Date.now() - this.#loadedAt >= STALE_MS;
  }

  refresh(): Promise<boolean> {
    this.#refreshing ??= this.#load()
      .then(
        () => true,
        (error: unknown) => {
          logger.warn({ err: error }, "connector auth: refreshing the connector cache failed");
          return false;
        },
      )
      .finally(() => {
        this.#refreshing = null;
      });
    return this.#refreshing;
  }

  /** Loads the active connectors; rejects when the read fails. */
  async #load(): Promise<void> {
    const startedAt = Date.now();
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
