/**
 * The hub's cache of active connectors, keyed on token hash
 * (design/connectors.md → Wire contract → Auth).
 */

import { err, ok, type Result } from "neverthrow";
import type { Transactor } from "../db/index.js";
import { logger } from "../logger.js";
import type { ActiveConnector, ConnectorStore } from "./store/index.js";
import { hashConnectorToken } from "./token.js";

/** At most one refresh per this long for tokens the cache does not recognise. */
const UNKNOWN_TOKEN_REFRESH_MS = 5_000;

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
  /** Reloads the cache from the table. Rejects when the read fails, keeping the old cache. */
  refresh(): Promise<void>;
}

export class ConnectorAuth implements ConnectorAuthCache {
  readonly #deps: ConnectorAuthDeps;
  #byHash = new Map<string, ActiveConnector>();
  #refreshedAt = Number.NEGATIVE_INFINITY;
  #refreshing: Promise<void> | null = null;

  private constructor(deps: ConnectorAuthDeps) {
    this.#deps = deps;
  }

  static async create(deps: ConnectorAuthDeps): Promise<ConnectorAuth> {
    const auth = new ConnectorAuth(deps);
    await auth.refresh();
    return auth;
  }

  async authenticate(rawToken: string): Promise<Result<ActiveConnector, AuthError>> {
    const tokenHash = hashConnectorToken(rawToken);
    const cached = this.#byHash.get(tokenHash);
    if (cached) return ok(cached);
    if (Date.now() - this.#refreshedAt < UNKNOWN_TOKEN_REFRESH_MS) {
      return err({ kind: "unauthenticated" });
    }
    try {
      await this.refresh();
    } catch (error) {
      logger.warn({ err: error }, "connector auth: refreshing the connector cache failed");
      return err({ kind: "unavailable" });
    }
    const found = this.#byHash.get(tokenHash);
    return found ? ok(found) : err({ kind: "unauthenticated" });
  }

  isCurrent(connector: ActiveConnector): boolean {
    return this.#byHash.get(connector.tokenHash)?.id === connector.id;
  }

  refresh(): Promise<void> {
    this.#refreshing ??= this.#load().finally(() => {
      this.#refreshing = null;
    });
    return this.#refreshing;
  }

  async #load(): Promise<void> {
    this.#refreshedAt = Date.now();
    const { runInTx, connectorStore } = this.#deps;
    const active = await runInTx((tx) => connectorStore.listActive(tx));
    this.#byHash = new Map(active.map((connector) => [connector.tokenHash, connector]));
  }
}
