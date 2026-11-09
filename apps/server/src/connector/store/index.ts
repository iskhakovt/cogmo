import { and, asc, eq } from "drizzle-orm";
import { err, ok, type Result } from "neverthrow";
import type { Transaction } from "../../db/index.js";
import {
  ACTIVE_CONNECTOR,
  type connectorKind,
  type connectorStatus,
  connectors,
} from "./schema.js";

export type ConnectorKind = (typeof connectorKind.enumValues)[number];
export type ConnectorStatus = (typeof connectorStatus.enumValues)[number];

/** What the hub's auth cache holds for each active connector. */
export interface ActiveConnector {
  readonly id: string;
  readonly name: string;
  readonly kind: ConnectorKind;
  readonly tokenHash: string;
}

/** A connector as `cogmo connector list` shows it. */
export interface ConnectorRow {
  id: string;
  name: string;
  kind: ConnectorKind;
  status: ConnectorStatus;
  createdAt: Date;
  revokedAt: Date | null;
}

// --- Interface ---

export interface ConnectorStore {
  /** Insert an active connector. `name_taken` when an active one holds the name. */
  insert(
    tx: Transaction,
    params: { name: string; kind: ConnectorKind; tokenHash: string },
  ): Promise<Result<{ id: string }, { kind: "name_taken" }>>;

  /** Replace the active connector's token hash. `not_found` when no active one has the name. */
  rotateToken(
    tx: Transaction,
    params: { name: string; tokenHash: string },
  ): Promise<Result<{ id: string }, { kind: "not_found" }>>;

  /** Move the active connector to `revoked`. `not_found` when no active one has the name. */
  revoke(
    tx: Transaction,
    params: { name: string; now: Date },
  ): Promise<Result<{ id: string }, { kind: "not_found" }>>;

  /** Every connector, active and revoked, oldest first. */
  list(tx: Transaction): Promise<ReadonlyArray<ConnectorRow>>;

  /** The active connectors, oldest first. */
  listActive(tx: Transaction): Promise<ReadonlyArray<ActiveConnector>>;
}

// --- Implementation ---

/** The conditional-UPDATE guard: the one active connector holding `name`. */
function isActiveNamed(name: string) {
  return and(eq(connectors.name, name), eq(connectors.status, "active"));
}

export class DrizzleConnectorStore implements ConnectorStore {
  async insert(
    tx: Transaction,
    params: { name: string; kind: ConnectorKind; tokenHash: string },
  ): Promise<Result<{ id: string }, { kind: "name_taken" }>> {
    const [row] = await tx
      .insert(connectors)
      .values({ ...params, status: "active" })
      .onConflictDoNothing({ target: connectors.name, where: ACTIVE_CONNECTOR })
      .returning({ id: connectors.id });
    return row === undefined ? err({ kind: "name_taken" }) : ok(row);
  }

  async rotateToken(
    tx: Transaction,
    params: { name: string; tokenHash: string },
  ): Promise<Result<{ id: string }, { kind: "not_found" }>> {
    const [row] = await tx
      .update(connectors)
      .set({ tokenHash: params.tokenHash })
      .where(isActiveNamed(params.name))
      .returning({ id: connectors.id });
    return row === undefined ? err({ kind: "not_found" }) : ok(row);
  }

  async revoke(
    tx: Transaction,
    params: { name: string; now: Date },
  ): Promise<Result<{ id: string }, { kind: "not_found" }>> {
    const [row] = await tx
      .update(connectors)
      .set({ status: "revoked", revokedAt: params.now })
      .where(isActiveNamed(params.name))
      .returning({ id: connectors.id });
    return row === undefined ? err({ kind: "not_found" }) : ok(row);
  }

  async list(tx: Transaction): Promise<ReadonlyArray<ConnectorRow>> {
    return tx
      .select({
        id: connectors.id,
        name: connectors.name,
        kind: connectors.kind,
        status: connectors.status,
        createdAt: connectors.createdAt,
        revokedAt: connectors.revokedAt,
      })
      .from(connectors)
      .orderBy(asc(connectors.createdAt), asc(connectors.id));
  }

  async listActive(tx: Transaction): Promise<ReadonlyArray<ActiveConnector>> {
    return tx
      .select({
        id: connectors.id,
        name: connectors.name,
        kind: connectors.kind,
        tokenHash: connectors.tokenHash,
      })
      .from(connectors)
      .where(eq(connectors.status, "active"))
      .orderBy(asc(connectors.createdAt), asc(connectors.id));
  }
}
