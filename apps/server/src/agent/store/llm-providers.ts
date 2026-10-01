import { and, asc, desc, eq, sql } from "drizzle-orm";
import { single } from "../../db/helpers.js";
import type { Transaction } from "../../db/index.js";
import type { CacheDialect } from "../../llm/cache-dialect.js";
import { type ExtraBody, ExtraBodySchema } from "../../llm/extra-body.js";
import {
  type LlmProviderTypeValue,
  llmProviders,
  modelProviders,
  type ProviderAttrs,
  ProviderAttrsSchema,
} from "./schema.js";

/**
 * The `llm_providers` rows and the `model_providers` routing rows that hang
 * off them: which endpoints serve which models, in what fallback order.
 */
export interface LlmProviderStore {
  // --- Model discovery (Transport-facing) ---

  /** Distinct models that are user-selectable (user_selectable = true). Used by the `/model` picker. */
  listDistinctUserSelectableModels(tx: Transaction): Promise<ReadonlyArray<string>>;

  /** True if at least one `model_providers` row has `user_selectable = true` for this model. Used to validate `profiles.update({ model })`. */
  isModelUserSelectable(tx: Transaction, model: string): Promise<boolean>;

  // --- LLM Providers ---

  /** Create an LLM provider configuration. */
  createProvider(
    tx: Transaction,
    params: {
      name: string;
      type: LlmProviderTypeValue;
      baseUrl?: string;
      secretId: string;
      attrs: ProviderAttrs;
    },
  ): Promise<{ id: string }>;

  /** Get a provider by ID. */
  getProvider(
    tx: Transaction,
    providerId: string,
  ): Promise<
    | {
        id: string;
        name: string;
        type: LlmProviderTypeValue;
        baseUrl: string | null;
        secretId: string;
        attrs: ProviderAttrs;
      }
    | undefined
  >;

  /** List all providers. */
  listProviders(tx: Transaction): Promise<
    ReadonlyArray<{
      id: string;
      name: string;
      type: LlmProviderTypeValue;
      baseUrl: string | null;
      attrs: ProviderAttrs;
    }>
  >;

  /**
   * Set a provider's `attrs.cacheDialect`, keeping its other attrs. False when
   * no provider has this id.
   */
  setProviderCacheDialect(
    tx: Transaction,
    providerId: string,
    cacheDialect: CacheDialect,
  ): Promise<boolean>;

  /** Delete a provider by ID (cascades to model_providers). */
  deleteProvider(tx: Transaction, providerId: string): Promise<void>;

  // --- Model → Provider routing ---

  /**
   * Register a provider for a model at a given position (lower = preferred).
   *
   * `userSelectable: false` hides the model from the user-facing `/model` picker
   * — use for internal-only models (summarization, experimental).
   *
   * `contextWindow` / `maxOutputTokens` are optional explicit overrides. Leave
   * undefined to let the resolver fall back through LiteLLM JSON → conservative
   * default. Set them only when the model is unknown to LiteLLM and the
   * default doesn't fit (e.g., a niche local model with a 1M context window).
   *
   * `extraBody` is the model's extra request fields on an OpenAI-compatible
   * provider; undefined or null stores none.
   */
  addModelProvider(
    tx: Transaction,
    params: {
      model: string;
      providerId: string;
      position: number;
      userSelectable: boolean;
      contextWindow?: number | null;
      maxOutputTokens?: number | null;
      extraBody?: ExtraBody | null;
    },
  ): Promise<{ id: string }>;

  /**
   * Replace the extra request fields of the `(model, providerId)` routing row;
   * null clears them. Returns whether a row matched.
   */
  setModelProviderExtraBody(
    tx: Transaction,
    model: string,
    providerId: string,
    extraBody: ExtraBody | null,
  ): Promise<boolean>;

  /**
   * List every provider registered for a model, ordered by position ASC
   * (primary first, then fallbacks). Empty array when no provider is
   * registered for the model. `position` reflects the actual stored
   * value — non-sequential after intermediate rows are deleted, so
   * callers should never use an array index as a substitute.
   */
  listProvidersForModel(
    tx: Transaction,
    model: string,
  ): Promise<
    ReadonlyArray<{
      id: string;
      name: string;
      type: LlmProviderTypeValue;
      baseUrl: string | null;
      secretId: string;
      attrs: ProviderAttrs;
      position: number;
      contextWindow: number | null;
      maxOutputTokens: number | null;
      extraBody: ExtraBody | null;
    }>
  >;

  /**
   * Every `model_providers` row joined with its owning `llm_providers`,
   * ordered by `(model, position)`. Single round trip for the whole
   * routing table — used by `cogmo model list` so the command doesn't
   * fan out one query per model.
   */
  listAllModelProviders(tx: Transaction): Promise<
    ReadonlyArray<{
      model: string;
      id: string;
      name: string;
      type: LlmProviderTypeValue;
      baseUrl: string | null;
      secretId: string;
      attrs: ProviderAttrs;
      position: number;
      contextWindow: number | null;
      maxOutputTokens: number | null;
      extraBody: ExtraBody | null;
    }>
  >;

  /** Get the next available position for a model (MAX(position) + 1, or 0 if none). */
  getNextModelProviderPosition(tx: Transaction, model: string): Promise<number>;

  /** Remove all model_providers entries for a given provider. */
  removeModelProvidersByProvider(tx: Transaction, providerId: string): Promise<void>;

  /** Remove a single model_providers row by `(model, providerId)`. */
  removeModelProvider(tx: Transaction, model: string, providerId: string): Promise<void>;

  /** Distinct list of every model id with at least one routing row. */
  listAllModels(tx: Transaction): Promise<ReadonlyArray<string>>;
}

export class DrizzleLlmProviderStore implements LlmProviderStore {
  // --- Model discovery ---

  async listDistinctUserSelectableModels(tx: Transaction): Promise<ReadonlyArray<string>> {
    const rows = await tx
      .selectDistinct({ model: modelProviders.model })
      .from(modelProviders)
      .where(eq(modelProviders.userSelectable, true))
      .orderBy(asc(modelProviders.model));
    return rows.map((r) => r.model);
  }

  async isModelUserSelectable(tx: Transaction, model: string): Promise<boolean> {
    const rows = await tx
      .select({ id: modelProviders.id })
      .from(modelProviders)
      .where(and(eq(modelProviders.model, model), eq(modelProviders.userSelectable, true)))
      .limit(1);
    return rows.length > 0;
  }

  // --- LLM Providers ---

  async createProvider(
    tx: Transaction,
    params: {
      name: string;
      type: LlmProviderTypeValue;
      baseUrl?: string;
      secretId: string;
      attrs: ProviderAttrs;
    },
  ): Promise<{ id: string }> {
    return single(
      await tx
        .insert(llmProviders)
        .values({
          name: params.name,
          type: params.type,
          baseUrl: params.baseUrl,
          secretId: params.secretId,
          attrs: params.attrs,
        })
        .returning({ id: llmProviders.id }),
    );
  }

  async getProvider(
    tx: Transaction,
    providerId: string,
  ): Promise<
    | {
        id: string;
        name: string;
        type: LlmProviderTypeValue;
        baseUrl: string | null;
        secretId: string;
        attrs: ProviderAttrs;
      }
    | undefined
  > {
    const rows = await tx
      .select({
        id: llmProviders.id,
        name: llmProviders.name,
        type: llmProviders.type,
        baseUrl: llmProviders.baseUrl,
        secretId: llmProviders.secretId,
        attrs: llmProviders.attrs,
      })
      .from(llmProviders)
      .where(eq(llmProviders.id, providerId))
      .limit(1);
    return rows[0];
  }

  async listProviders(tx: Transaction): Promise<
    ReadonlyArray<{
      id: string;
      name: string;
      type: LlmProviderTypeValue;
      baseUrl: string | null;
      attrs: ProviderAttrs;
    }>
  > {
    return tx
      .select({
        id: llmProviders.id,
        name: llmProviders.name,
        type: llmProviders.type,
        baseUrl: llmProviders.baseUrl,
        attrs: llmProviders.attrs,
      })
      .from(llmProviders);
  }

  async setProviderCacheDialect(
    tx: Transaction,
    providerId: string,
    cacheDialect: CacheDialect,
  ): Promise<boolean> {
    // JSONB `||` merges the key into the row's attrs in one UPDATE, bypassing
    // the column's write validation, so the patch is validated here.
    const patch = ProviderAttrsSchema.parse({ cacheDialect });
    const rows = await tx
      .update(llmProviders)
      .set({ attrs: sql`${llmProviders.attrs} || ${JSON.stringify(patch)}::jsonb` })
      .where(eq(llmProviders.id, providerId))
      .returning({ id: llmProviders.id });
    return rows.length > 0;
  }

  async deleteProvider(tx: Transaction, providerId: string): Promise<void> {
    // model_providers cascade-deletes via ON DELETE CASCADE
    await tx.delete(llmProviders).where(eq(llmProviders.id, providerId));
  }

  // --- Model → Provider routing ---

  async addModelProvider(
    tx: Transaction,
    params: {
      model: string;
      providerId: string;
      position: number;
      userSelectable: boolean;
      contextWindow?: number | null;
      maxOutputTokens?: number | null;
      extraBody?: ExtraBody | null;
    },
  ): Promise<{ id: string }> {
    const { contextWindow, maxOutputTokens, extraBody, ...rest } = params;
    // The column reads leniently, so a write is checked against the strict schema here.
    if (extraBody != null) ExtraBodySchema.parse(extraBody);
    return single(
      await tx
        .insert(modelProviders)
        .values({
          ...rest,
          contextWindow: contextWindow ?? null,
          maxOutputTokens: maxOutputTokens ?? null,
          extraBody: extraBody ?? null,
        })
        .returning({ id: modelProviders.id }),
    );
  }

  async setModelProviderExtraBody(
    tx: Transaction,
    model: string,
    providerId: string,
    extraBody: ExtraBody | null,
  ): Promise<boolean> {
    // The column reads leniently, so a write is checked against the strict schema here.
    if (extraBody !== null) ExtraBodySchema.parse(extraBody);
    const rows = await tx
      .update(modelProviders)
      .set({ extraBody })
      .where(and(eq(modelProviders.model, model), eq(modelProviders.providerId, providerId)))
      .returning({ id: modelProviders.id });
    return rows.length > 0;
  }

  async listProvidersForModel(
    tx: Transaction,
    model: string,
  ): Promise<
    ReadonlyArray<{
      id: string;
      name: string;
      type: LlmProviderTypeValue;
      baseUrl: string | null;
      secretId: string;
      attrs: ProviderAttrs;
      position: number;
      contextWindow: number | null;
      maxOutputTokens: number | null;
      extraBody: ExtraBody | null;
    }>
  > {
    const rows = await tx
      .select({
        id: llmProviders.id,
        name: llmProviders.name,
        type: llmProviders.type,
        baseUrl: llmProviders.baseUrl,
        secretId: llmProviders.secretId,
        attrs: llmProviders.attrs,
        position: modelProviders.position,
        contextWindow: modelProviders.contextWindow,
        maxOutputTokens: modelProviders.maxOutputTokens,
        extraBody: modelProviders.extraBody,
      })
      .from(modelProviders)
      .innerJoin(llmProviders, eq(modelProviders.providerId, llmProviders.id))
      .where(eq(modelProviders.model, model))
      .orderBy(asc(modelProviders.position));
    return rows;
  }

  async listAllModelProviders(tx: Transaction): Promise<
    ReadonlyArray<{
      model: string;
      id: string;
      name: string;
      type: LlmProviderTypeValue;
      baseUrl: string | null;
      secretId: string;
      attrs: ProviderAttrs;
      position: number;
      contextWindow: number | null;
      maxOutputTokens: number | null;
      extraBody: ExtraBody | null;
    }>
  > {
    const rows = await tx
      .select({
        model: modelProviders.model,
        id: llmProviders.id,
        name: llmProviders.name,
        type: llmProviders.type,
        baseUrl: llmProviders.baseUrl,
        secretId: llmProviders.secretId,
        attrs: llmProviders.attrs,
        position: modelProviders.position,
        contextWindow: modelProviders.contextWindow,
        maxOutputTokens: modelProviders.maxOutputTokens,
        extraBody: modelProviders.extraBody,
      })
      .from(modelProviders)
      .innerJoin(llmProviders, eq(modelProviders.providerId, llmProviders.id))
      .orderBy(asc(modelProviders.model), asc(modelProviders.position));
    return rows;
  }

  async getNextModelProviderPosition(tx: Transaction, model: string): Promise<number> {
    const rows = await tx
      .select({ position: modelProviders.position })
      .from(modelProviders)
      .where(eq(modelProviders.model, model))
      .orderBy(desc(modelProviders.position))
      .limit(1);
    return rows[0] ? rows[0].position + 1 : 0;
  }

  async removeModelProvidersByProvider(tx: Transaction, providerId: string): Promise<void> {
    await tx.delete(modelProviders).where(eq(modelProviders.providerId, providerId));
  }

  async removeModelProvider(tx: Transaction, model: string, providerId: string): Promise<void> {
    await tx
      .delete(modelProviders)
      .where(and(eq(modelProviders.model, model), eq(modelProviders.providerId, providerId)));
  }

  async listAllModels(tx: Transaction): Promise<ReadonlyArray<string>> {
    const rows = await tx
      .selectDistinct({ model: modelProviders.model })
      .from(modelProviders)
      .orderBy(asc(modelProviders.model));
    return rows.map((r) => r.model);
  }
}
