import { and, asc, count, eq } from "drizzle-orm";
import { err, type Result } from "neverthrow";
import { single } from "../../db/helpers.js";
import type { Transaction } from "../../db/index.js";
import { isCoreCompartment } from "../evolution/memory-extraction-schema.js";
import { CANONICAL_NAME_RE } from "./canonical-name.js";
import { type CreateCustomCompartmentError, inSavepoint, uniqueViolationAs } from "./errors.js";
import { customCompartments } from "./schema.js";

/**
 * Hard cap on per-user custom compartments. Keeps the classifier prompt
 * bounded and protects accuracy — beyond ~10 buckets the LLM's
 * compartment choice degrades, and the prompt grows linearly with the
 * count. Cap is enforced at insert time (count + insert in one tx).
 */
export const CUSTOM_COMPARTMENT_LIMIT = 10;

/**
 * Per-user registry row for a custom compartment. `description` is loaded
 * by the Observer on each fire and templated into the classifier prompt
 * (`buildCompartmentDefinitions`) — it's an LLM-facing definition, not
 * documentation.
 */
export interface CustomCompartment {
  id: string;
  userId: string;
  name: string;
  description: string;
  createdAt: Date;
}

/** The `custom_compartments` rows: the per-user extension of the memory-domain registry. */
export interface CompartmentStore {
  /** List the user's registered custom compartments, ordered by name. */
  listCustomCompartments(
    tx: Transaction,
    userId: string,
  ): Promise<ReadonlyArray<CustomCompartment>>;

  /**
   * Create a new custom compartment for the user. Enforces:
   *   - canonical name shape (`CANONICAL_NAME_RE`) → `invalid_name`
   *   - reserved-name check against `CORE_COMPARTMENTS` →
   *     `compartment_name_reserved`
   *   - per-user cap of `CUSTOM_COMPARTMENT_LIMIT` →
   *     `compartment_cap_exceeded`
   *   - unique `(user_id, name)` → `compartment_name_taken`
   *
   * Cap is enforced via a count-then-insert in the same transaction.
   * REPEATABLE READ (the project default) doesn't catch this predicate
   * race — snapshot isolation doesn't predicate-lock. At single-user
   * scale + UI-only writes the residual race (concurrent inserts both
   * seeing count=N-1) is acceptable; when multi-tenant lands, prevent it
   * with an advisory lock taken before the snapshot, not SERIALIZABLE —
   * see `.claude/rules/store-pattern.md`.
   */
  createCustomCompartment(
    tx: Transaction,
    params: { userId: string; name: string; description: string },
  ): Promise<Result<CustomCompartment, CreateCustomCompartmentError>>;

  /**
   * Delete a custom compartment by name. Returns `{ deleted: false }` if no
   * row matches; `{ deleted: true }` on success. Forward-only: existing
   * `compartment:<name>` Hindsight tags survive (Cogmo doesn't store the
   * memory rows itself, so an FK-style RESTRICT isn't possible). Profiles
   * whose `memory_scope.compartments` array references the deleted name
   * remain valid — recall-time predicate just stops matching new memories.
   */
  deleteCustomCompartment(
    tx: Transaction,
    userId: string,
    name: string,
  ): Promise<{ deleted: boolean }>;
}

export class DrizzleCompartmentStore implements CompartmentStore {
  async listCustomCompartments(
    tx: Transaction,
    userId: string,
  ): Promise<ReadonlyArray<CustomCompartment>> {
    return tx
      .select({
        id: customCompartments.id,
        userId: customCompartments.userId,
        name: customCompartments.name,
        description: customCompartments.description,
        createdAt: customCompartments.createdAt,
      })
      .from(customCompartments)
      .where(eq(customCompartments.userId, userId))
      .orderBy(asc(customCompartments.name));
  }

  async createCustomCompartment(
    tx: Transaction,
    params: { userId: string; name: string; description: string },
  ): Promise<Result<CustomCompartment, CreateCustomCompartmentError>> {
    if (!CANONICAL_NAME_RE.test(params.name)) {
      return err({ kind: "invalid_name", name: params.name, subject: "compartment" });
    }
    if (isCoreCompartment(params.name)) {
      return err({ kind: "compartment_name_reserved", name: params.name });
    }
    const countRows = await tx
      .select({ value: count() })
      .from(customCompartments)
      .where(eq(customCompartments.userId, params.userId));
    const current = countRows[0]?.value ?? 0;
    if (current >= CUSTOM_COMPARTMENT_LIMIT) {
      return err({ kind: "compartment_cap_exceeded", limit: CUSTOM_COMPARTMENT_LIMIT, current });
    }
    return inSavepoint(tx, (sp) =>
      uniqueViolationAs(
        "uq_custom_compartments_user_name",
        { kind: "compartment_name_taken", name: params.name } as const,
        async () =>
          single(
            await sp.insert(customCompartments).values(params).returning({
              id: customCompartments.id,
              userId: customCompartments.userId,
              name: customCompartments.name,
              description: customCompartments.description,
              createdAt: customCompartments.createdAt,
            }),
          ),
      ),
    );
  }

  async deleteCustomCompartment(
    tx: Transaction,
    userId: string,
    name: string,
  ): Promise<{ deleted: boolean }> {
    const deleted = await tx
      .delete(customCompartments)
      .where(and(eq(customCompartments.userId, userId), eq(customCompartments.name, name)))
      .returning({ id: customCompartments.id });
    return { deleted: deleted.length > 0 };
  }
}
