import { eq, type SQL } from "drizzle-orm";
import { single } from "../../db/helpers.js";
import type { Transaction } from "../../db/index.js";
import { decrypt, encrypt, fromBase64, toBase64 } from "../encryption.js";
import { secrets } from "./schema.js";

// --- Interface ---

/** A secret's row without its value. */
export interface SecretMeta {
  id: string;
  name: string;
  description: string | null;
  validatedAt: Date | null;
}

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

  /** Get a decrypted secret by name. `undefined` if not found. */
  getSecret(tx: Transaction, name: string): Promise<string | undefined>;

  /** Get a decrypted secret by row ID. `undefined` if not found. */
  getSecretById(tx: Transaction, id: string): Promise<string | undefined>;

  /** Get secret metadata without decrypting (for display). */
  getSecretMeta(tx: Transaction, name: string): Promise<SecretMeta | undefined>;

  /** List all secret names (no values). */
  listSecrets(tx: Transaction): Promise<ReadonlyArray<SecretMeta>>;

  /** Mark a secret as validated (after successful provider ping). */
  markValidated(tx: Transaction, name: string): Promise<void>;

  /** Delete a secret by name. */
  deleteSecret(tx: Transaction, name: string): Promise<void>;

  /** Delete all secrets. */
  deleteAllSecrets(tx: Transaction): Promise<void>;
}

// --- Implementation ---

const META_COLUMNS = {
  id: secrets.id,
  name: secrets.name,
  description: secrets.description,
  validatedAt: secrets.validatedAt,
};

export class DrizzleSecretsStore implements SecretsStore {
  readonly #key: Uint8Array;

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

  getSecret(tx: Transaction, name: string): Promise<string | undefined> {
    return this.#decryptWhere(tx, eq(secrets.name, name));
  }

  getSecretById(tx: Transaction, id: string): Promise<string | undefined> {
    return this.#decryptWhere(tx, eq(secrets.id, id));
  }

  async getSecretMeta(tx: Transaction, name: string): Promise<SecretMeta | undefined> {
    const rows = await tx.select(META_COLUMNS).from(secrets).where(eq(secrets.name, name)).limit(1);
    return rows[0];
  }

  async listSecrets(tx: Transaction): Promise<ReadonlyArray<SecretMeta>> {
    return tx.select(META_COLUMNS).from(secrets);
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

  async #decryptWhere(tx: Transaction, where: SQL): Promise<string | undefined> {
    const rows = await tx
      .select({ ciphertext: secrets.ciphertext, nonce: secrets.nonce })
      .from(secrets)
      .where(where)
      .limit(1);
    const row = rows[0];
    if (!row) return undefined;
    return decrypt(this.#key, fromBase64(row.ciphertext), fromBase64(row.nonce));
  }
}
