import { eq } from "drizzle-orm";
import { single } from "../../db/helpers.js";
import type { Transactor } from "../../db/index.js";
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
  getSecret(name: string): Promise<string | undefined>;

  /** Get a decrypted secret by row ID. Returns null if not found. */
  getSecretById(id: string): Promise<string | undefined>;

  /** Get secret metadata without decrypting (for display). */
  getSecretMeta(name: string): Promise<
    | {
        id: string;
        name: string;
        description: string | null;
        validatedAt: Date | null;
      }
    | undefined
  >;

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
  #runInTx: Transactor;
  #key: Uint8Array;

  constructor(runInTx: Transactor, encryptionKey: Uint8Array) {
    this.#runInTx = runInTx;
    this.#key = encryptionKey;
  }

  async putSecret(params: {
    name: string;
    plaintext: string;
    description?: string;
  }): Promise<{ id: string }> {
    const { ciphertext, nonce } = encrypt(this.#key, params.plaintext);
    return this.#runInTx(async (tx) => {
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
              validatedAt: null, // clear stale validation on rotation
              ...(params.description !== undefined && { description: params.description }),
            },
          })
          .returning({ id: secrets.id }),
      );
    });
  }

  async getSecret(name: string): Promise<string | undefined> {
    return this.#runInTx(async (tx) => {
      const rows = await tx
        .select({ ciphertext: secrets.ciphertext, nonce: secrets.nonce })
        .from(secrets)
        .where(eq(secrets.name, name))
        .limit(1);
      const row = rows[0];
      if (!row) return undefined;
      return decrypt(this.#key, fromBase64(row.ciphertext), fromBase64(row.nonce));
    });
  }

  async getSecretById(id: string): Promise<string | undefined> {
    return this.#runInTx(async (tx) => {
      const rows = await tx
        .select({ ciphertext: secrets.ciphertext, nonce: secrets.nonce })
        .from(secrets)
        .where(eq(secrets.id, id))
        .limit(1);
      const row = rows[0];
      if (!row) return undefined;
      return decrypt(this.#key, fromBase64(row.ciphertext), fromBase64(row.nonce));
    });
  }

  async getSecretMeta(name: string): Promise<
    | {
        id: string;
        name: string;
        description: string | null;
        validatedAt: Date | null;
      }
    | undefined
  > {
    return this.#runInTx(async (tx) => {
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
      return rows[0];
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
    return this.#runInTx(async (tx) => {
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
    await this.#runInTx(async (tx) => {
      await tx.update(secrets).set({ validatedAt: new Date() }).where(eq(secrets.name, name));
    });
  }

  async deleteSecret(name: string): Promise<void> {
    await this.#runInTx(async (tx) => {
      await tx.delete(secrets).where(eq(secrets.name, name));
    });
  }

  async deleteAllSecrets(): Promise<void> {
    await this.#runInTx(async (tx) => {
      await tx.delete(secrets);
    });
  }
}
