import { eq } from "drizzle-orm";
import { single } from "../../db/helpers.js";
import type { Transaction } from "../../db/index.js";
import { decrypt, encrypt, fromBase64, toBase64 } from "../encryption.js";
import { secrets } from "./schema.js";

// --- Interface ---

export interface SecretsStore {
  /** Upsert a secret (encrypts before storing). */
  putSecret(
    tx: Transaction,
    params: {
      name: string;
      plaintext: string;
      description?: string;
    },
  ): Promise<{ id: string }>;

  /** Get a decrypted secret by name. Returns null if not found. */
  getSecret(tx: Transaction, name: string): Promise<string | undefined>;

  /** Get a decrypted secret by row ID. Returns null if not found. */
  getSecretById(tx: Transaction, id: string): Promise<string | undefined>;

  /** Get secret metadata without decrypting (for display). */
  getSecretMeta(
    tx: Transaction,
    name: string,
  ): Promise<
    | {
        id: string;
        name: string;
        description: string | null;
        validatedAt: Date | null;
      }
    | undefined
  >;

  /** List all secret names (no values). */
  listSecrets(tx: Transaction): Promise<
    ReadonlyArray<{
      id: string;
      name: string;
      description: string | null;
      validatedAt: Date | null;
    }>
  >;

  /** Mark a secret as validated (after successful provider ping). */
  markValidated(tx: Transaction, name: string): Promise<void>;

  /** Delete a secret by name. */
  deleteSecret(tx: Transaction, name: string): Promise<void>;

  /** Delete all secrets. */
  deleteAllSecrets(tx: Transaction): Promise<void>;
}

// --- Implementation ---

export class DrizzleSecretsStore implements SecretsStore {
  #key: Uint8Array;

  constructor(encryptionKey: Uint8Array) {
    this.#key = encryptionKey;
  }

  async putSecret(
    tx: Transaction,
    params: {
      name: string;
      plaintext: string;
      description?: string;
    },
  ): Promise<{ id: string }> {
    const { ciphertext, nonce } = encrypt(this.#key, params.plaintext);
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
  }

  async getSecret(tx: Transaction, name: string): Promise<string | undefined> {
    const rows = await tx
      .select({ ciphertext: secrets.ciphertext, nonce: secrets.nonce })
      .from(secrets)
      .where(eq(secrets.name, name))
      .limit(1);
    const row = rows[0];
    if (!row) return undefined;
    return decrypt(this.#key, fromBase64(row.ciphertext), fromBase64(row.nonce));
  }

  async getSecretById(tx: Transaction, id: string): Promise<string | undefined> {
    const rows = await tx
      .select({ ciphertext: secrets.ciphertext, nonce: secrets.nonce })
      .from(secrets)
      .where(eq(secrets.id, id))
      .limit(1);
    const row = rows[0];
    if (!row) return undefined;
    return decrypt(this.#key, fromBase64(row.ciphertext), fromBase64(row.nonce));
  }

  async getSecretMeta(
    tx: Transaction,
    name: string,
  ): Promise<
    | {
        id: string;
        name: string;
        description: string | null;
        validatedAt: Date | null;
      }
    | undefined
  > {
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
  }

  async listSecrets(tx: Transaction): Promise<
    ReadonlyArray<{
      id: string;
      name: string;
      description: string | null;
      validatedAt: Date | null;
    }>
  > {
    return tx
      .select({
        id: secrets.id,
        name: secrets.name,
        description: secrets.description,
        validatedAt: secrets.validatedAt,
      })
      .from(secrets);
  }

  async markValidated(tx: Transaction, name: string): Promise<void> {
    await tx.update(secrets).set({ validatedAt: new Date() }).where(eq(secrets.name, name));
  }

  async deleteSecret(tx: Transaction, name: string): Promise<void> {
    await tx.delete(secrets).where(eq(secrets.name, name));
  }

  async deleteAllSecrets(tx: Transaction): Promise<void> {
    await tx.delete(secrets);
  }
}
