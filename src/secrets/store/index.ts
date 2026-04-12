import { eq } from "drizzle-orm";
import { single } from "../../db/helpers.js";
import type { Database } from "../../db/index.js";
import { decrypt, encrypt, fromBase64, toBase64 } from "../encryption.js";
import { secrets } from "./schema.js";

// --- Interface ---

export interface SecretsStore {
  /** Upsert a secret (encrypts before storing). */
  putSecret(params: {
    name: string;
    plaintext: string;
    description?: string;
  }): Promise<{ id: string }>;

  /** Get a decrypted secret by name. Returns null if not found. */
  getSecret(name: string): Promise<string | null>;

  /** Get a decrypted secret by row ID. Returns null if not found. */
  getSecretById(id: string): Promise<string | null>;

  /** Get secret metadata without decrypting (for display). */
  getSecretMeta(name: string): Promise<{
    id: string;
    name: string;
    description: string | null;
    validatedAt: Date | null;
  } | null>;

  /** List all secret names (no values). */
  listSecrets(): Promise<
    ReadonlyArray<{
      id: string;
      name: string;
      description: string | null;
      validatedAt: Date | null;
    }>
  >;

  /** Mark a secret as validated (after successful provider ping). */
  markValidated(name: string): Promise<void>;

  /** Delete a secret by name. */
  deleteSecret(name: string): Promise<void>;

  /** Delete all secrets. */
  deleteAllSecrets(): Promise<void>;
}

// --- Implementation ---

export class DrizzleSecretsStore implements SecretsStore {
  #db: Database;
  #key: Uint8Array;

  constructor(db: Database, encryptionKey: Uint8Array) {
    this.#db = db;
    this.#key = encryptionKey;
  }

  async putSecret(params: {
    name: string;
    plaintext: string;
    description?: string;
  }): Promise<{ id: string }> {
    const { ciphertext, nonce } = encrypt(this.#key, params.plaintext);
    return this.#db.transaction(async (tx) => {
      return single(
        await tx
          .insert(secrets)
          .values({
            name: params.name,
            ciphertext: toBase64(ciphertext),
            nonce: toBase64(nonce),
            description: params.description,
          })
          .onConflictDoUpdate({
            target: secrets.name,
            set: {
              ciphertext: toBase64(ciphertext),
              nonce: toBase64(nonce),
              ...(params.description !== undefined && { description: params.description }),
            },
          })
          .returning({ id: secrets.id }),
      );
    });
  }

  async getSecret(name: string): Promise<string | null> {
    return this.#db.transaction(async (tx) => {
      const rows = await tx
        .select({ ciphertext: secrets.ciphertext, nonce: secrets.nonce })
        .from(secrets)
        .where(eq(secrets.name, name))
        .limit(1);
      const row = rows[0];
      if (!row) return null;
      return decrypt(this.#key, fromBase64(row.ciphertext), fromBase64(row.nonce));
    });
  }

  async getSecretById(id: string): Promise<string | null> {
    return this.#db.transaction(async (tx) => {
      const rows = await tx
        .select({ ciphertext: secrets.ciphertext, nonce: secrets.nonce })
        .from(secrets)
        .where(eq(secrets.id, id))
        .limit(1);
      const row = rows[0];
      if (!row) return null;
      return decrypt(this.#key, fromBase64(row.ciphertext), fromBase64(row.nonce));
    });
  }

  async getSecretMeta(name: string): Promise<{
    id: string;
    name: string;
    description: string | null;
    validatedAt: Date | null;
  } | null> {
    return this.#db.transaction(async (tx) => {
      const rows = await tx
        .select({
          id: secrets.id,
          name: secrets.name,
          description: secrets.description,
          validatedAt: secrets.validatedAt,
        })
        .from(secrets)
        .where(eq(secrets.name, name))
        .limit(1);
      return rows[0] ?? null;
    });
  }

  async listSecrets(): Promise<
    ReadonlyArray<{
      id: string;
      name: string;
      description: string | null;
      validatedAt: Date | null;
    }>
  > {
    return this.#db.transaction(async (tx) => {
      return tx
        .select({
          id: secrets.id,
          name: secrets.name,
          description: secrets.description,
          validatedAt: secrets.validatedAt,
        })
        .from(secrets);
    });
  }

  async markValidated(name: string): Promise<void> {
    await this.#db.transaction(async (tx) => {
      await tx.update(secrets).set({ validatedAt: new Date() }).where(eq(secrets.name, name));
    });
  }

  async deleteSecret(name: string): Promise<void> {
    await this.#db.transaction(async (tx) => {
      await tx.delete(secrets).where(eq(secrets.name, name));
    });
  }

  async deleteAllSecrets(): Promise<void> {
    await this.#db.transaction(async (tx) => {
      await tx.delete(secrets);
    });
  }
}
