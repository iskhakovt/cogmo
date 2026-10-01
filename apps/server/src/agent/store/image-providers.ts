import { asc, eq } from "drizzle-orm";
import { err, ok, type Result } from "neverthrow";
import { single } from "../../db/helpers.js";
import type { Transaction } from "../../db/index.js";
import { imageModelSlug } from "../image-tools.js";
import {
  type CreateImageModelError,
  type CreateImageProviderError,
  type ImageModelSlugCollision,
  type InvalidProviderConfig,
  inSavepoint,
  uniqueViolationAs,
} from "./errors.js";
import {
  type ImageModelCapabilities,
  type ImageProviderAttrs,
  type ImageProviderTypeValue,
  imageModels,
  imageProviders,
} from "./schema.js";

/** A row from `image_providers`. `type` is narrowed via the `pgEnum`. */
export interface ImageProviderRow {
  id: string;
  name: string;
  type: ImageProviderTypeValue;
  baseUrl: string | null;
  secretId: string;
  attrs: ImageProviderAttrs;
}

/** A row from `image_models`. `capabilities` is the validated JSONB bag. */
export interface ImageModelRow {
  id: string;
  providerId: string;
  name: string;
  modelString: string;
  description: string;
  capabilities: ImageModelCapabilities;
  userSelectable: boolean;
}

/**
 * Joined view: an `image_models` row with its owning `image_providers` row
 * inlined. Returned by `listImageModelsWithProvider` so bootstrap can build
 * the tool catalog without a second round-trip per row.
 */
export interface ImageModelWithProvider extends ImageModelRow {
  provider: ImageProviderRow;
}

/**
 * Validate `(type, base_url)` for an image provider, for the cases the DB
 * CHECK can't express. The CHECK still enforces the coarser
 * `openai_compatible ↔ NOT NULL`, `venice ↔ NOT NULL`, `fal ↔ NULL`
 * invariant; this runs first so the operator gets a reason instead of an
 * opaque 23514.
 */
function validateImageProviderBaseUrl(
  type: ImageProviderTypeValue,
  baseUrl: string | null,
): Result<void, InvalidProviderConfig> {
  const invalid = (reason: string) => err({ kind: "invalid_provider_config" as const, reason });
  // Exhaustive over `image_provider_type`: a new enum value without a case
  // leaves a path with no return, which is a compile error.
  switch (type) {
    case "fal":
      return baseUrl === null ? ok(undefined) : invalid("fal does not accept a base_url");
    case "openai_compatible":
    case "venice": {
      if (baseUrl === null) return invalid(`${type} requires a base_url`);
      if (!URL.canParse(baseUrl)) return invalid(`base_url is not a valid URL: ${baseUrl}`);
      const { protocol } = new URL(baseUrl);
      if (protocol !== "https:") return invalid(`base_url must be https (got ${protocol})`);
      if (baseUrl.endsWith("/")) return invalid("base_url must not end with a trailing slash");
      return ok(undefined);
    }
  }
}

/**
 * The `image_providers` rows and the `image_models` catalog that hangs off
 * them: the image-generation endpoints and the models the LLM may pick.
 */
export interface ImageProviderStore {
  // --- Image Providers ---

  /**
   * Create an image-gen provider row. `baseUrl` is required for
   * `openai_compatible` / `venice` (https, parseable, no trailing slash) and
   * forbidden for `fal`; a violation is `invalid_provider_config`, with a
   * reason, before the row reaches the DB.
   */
  createImageProvider(
    tx: Transaction,
    params: {
      name: string;
      type: ImageProviderTypeValue;
      baseUrl: string | null;
      secretId: string;
      attrs: ImageProviderAttrs;
    },
  ): Promise<Result<{ id: string }, CreateImageProviderError>>;

  /** Get an image provider by ID. */
  getImageProvider(tx: Transaction, providerId: string): Promise<ImageProviderRow | undefined>;

  /** Look up an image provider by its unique name. */
  findImageProviderByName(tx: Transaction, name: string): Promise<ImageProviderRow | undefined>;

  /** List every image provider. */
  listImageProviders(tx: Transaction): Promise<ReadonlyArray<ImageProviderRow>>;

  /** Delete an image provider; cascades to its `image_models` rows. */
  deleteImageProvider(tx: Transaction, providerId: string): Promise<void>;

  // --- Image Models ---

  /**
   * Create an image-model catalog row. Fails on an exact-name collision, or
   * a slug collision (`replicate/flux-pro` when `fal-ai/flux-pro` exists),
   * since the slug is all the LLM sees. The Zod schema on `capabilities`
   * (run inside `jsonbZod`) validates the bag at write time — invalid aspect
   * ratios or unexpected fields throw before reaching the DB.
   */
  createImageModel(
    tx: Transaction,
    params: {
      providerId: string;
      name: string;
      modelString: string;
      description: string;
      capabilities: ImageModelCapabilities;
      userSelectable: boolean;
    },
  ): Promise<Result<{ id: string }, CreateImageModelError>>;

  /**
   * Bulk-insert image models keyed on `(providerId, name)`. Rows whose
   * `name` already exists are skipped (idempotent re-run). Returns the
   * count of rows actually inserted — operator edits to existing rows
   * are preserved. Used by `ensureFalImageDefaults`. A new row whose
   * `name` slug-collides with an existing or sibling row fails the batch,
   * inserting nothing.
   */
  upsertImageModelsByName(
    tx: Transaction,
    rows: ReadonlyArray<{
      providerId: string;
      name: string;
      modelString: string;
      description: string;
      capabilities: ImageModelCapabilities;
      userSelectable: boolean;
    }>,
  ): Promise<Result<number, ImageModelSlugCollision>>;

  /**
   * List every image model. When `userSelectableOnly: true`, filters to
   * rows the LLM is allowed to pick — bootstrap uses that filter to build
   * the `generate_image` tool's `model` enum.
   */
  listImageModels(
    tx: Transaction,
    opts?: { userSelectableOnly?: boolean },
  ): Promise<ReadonlyArray<ImageModelRow>>;

  /**
   * Like `listImageModels`, but joins in the owning `image_providers` row
   * so the caller can build a single tool catalog without per-row
   * follow-up queries. Sorted by model `name` for stable tool-description
   * output across boots.
   */
  listImageModelsWithProvider(
    tx: Transaction,
    opts?: { userSelectableOnly?: boolean },
  ): Promise<ReadonlyArray<ImageModelWithProvider>>;

  /** Delete a single image model. */
  deleteImageModel(tx: Transaction, modelId: string): Promise<void>;
}

export class DrizzleImageProviderStore implements ImageProviderStore {
  // --- Image Providers ---

  async createImageProvider(
    tx: Transaction,
    params: {
      name: string;
      type: ImageProviderTypeValue;
      baseUrl: string | null;
      secretId: string;
      attrs: ImageProviderAttrs;
    },
  ): Promise<Result<{ id: string }, CreateImageProviderError>> {
    const valid = validateImageProviderBaseUrl(params.type, params.baseUrl);
    if (valid.isErr()) return err(valid.error);
    return inSavepoint(tx, (sp) =>
      uniqueViolationAs(
        "image_providers_name_unique",
        { kind: "image_provider_name_taken", name: params.name } as const,
        async () =>
          single(
            await sp
              .insert(imageProviders)
              .values({
                name: params.name,
                type: params.type,
                baseUrl: params.baseUrl,
                secretId: params.secretId,
                attrs: params.attrs,
              })
              .returning({ id: imageProviders.id }),
          ),
      ),
    );
  }

  async getImageProvider(
    tx: Transaction,
    providerId: string,
  ): Promise<ImageProviderRow | undefined> {
    const rows = await tx
      .select()
      .from(imageProviders)
      .where(eq(imageProviders.id, providerId))
      .limit(1);
    return rows[0];
  }

  async findImageProviderByName(
    tx: Transaction,
    name: string,
  ): Promise<ImageProviderRow | undefined> {
    const rows = await tx
      .select()
      .from(imageProviders)
      .where(eq(imageProviders.name, name))
      .limit(1);
    return rows[0];
  }

  async listImageProviders(tx: Transaction): Promise<ReadonlyArray<ImageProviderRow>> {
    return tx.select().from(imageProviders).orderBy(asc(imageProviders.name));
  }

  async deleteImageProvider(tx: Transaction, providerId: string): Promise<void> {
    // image_models rows cascade-delete via ON DELETE CASCADE.
    await tx.delete(imageProviders).where(eq(imageProviders.id, providerId));
  }

  // --- Image Models ---

  async createImageModel(
    tx: Transaction,
    params: {
      providerId: string;
      name: string;
      modelString: string;
      description: string;
      capabilities: ImageModelCapabilities;
      userSelectable: boolean;
    },
  ): Promise<Result<{ id: string }, CreateImageModelError>> {
    // The catalog is tiny (~10 rows); a SELECT-then-check is simpler than a
    // SQL-expression unique index. Two concurrent adds can both pass it,
    // which at single-operator scale is a benign residual.
    const slug = imageModelSlug(params.name);
    const existing = await tx.select({ name: imageModels.name }).from(imageModels);
    const collision = existing.find(
      (r) => r.name !== params.name && imageModelSlug(r.name) === slug,
    );
    if (collision) {
      return err({
        kind: "image_model_slug_collision",
        name: params.name,
        existingName: collision.name,
        slug,
      });
    }
    return inSavepoint(tx, (sp) =>
      uniqueViolationAs(
        "image_models_name_unique",
        { kind: "image_model_name_taken", name: params.name } as const,
        async () =>
          single(await sp.insert(imageModels).values(params).returning({ id: imageModels.id })),
      ),
    );
  }

  async upsertImageModelsByName(
    tx: Transaction,
    rows: ReadonlyArray<{
      providerId: string;
      name: string;
      modelString: string;
      description: string;
      capabilities: ImageModelCapabilities;
      userSelectable: boolean;
    }>,
  ): Promise<Result<number, ImageModelSlugCollision>> {
    if (rows.length === 0) return ok(0);
    // Slug-collision pre-check across (existing rows ∪ new rows in this
    // batch). Rows whose `name` matches an existing row are skipped (the
    // idempotent path used by ensureFalImageDefaults); a different new
    // name with a colliding slug fails the batch.
    const existingNames = (await tx.select({ name: imageModels.name }).from(imageModels)).map(
      (r) => r.name,
    );
    const existingByName = new Set(existingNames);
    const seenSlugs = new Map<string, string>(existingNames.map((n) => [imageModelSlug(n), n]));
    for (const row of rows) {
      if (existingByName.has(row.name)) continue;
      const slug = imageModelSlug(row.name);
      const collision = seenSlugs.get(slug);
      if (collision !== undefined && collision !== row.name) {
        return err({
          kind: "image_model_slug_collision",
          name: row.name,
          existingName: collision,
          slug,
        });
      }
      seenSlugs.set(slug, row.name);
    }
    // Idempotent: skip rows whose `name` already exists. Operator edits to
    // existing rows survive re-runs of `ensureFalImageDefaults`.
    const inserted = await tx
      .insert(imageModels)
      .values([...rows])
      .onConflictDoNothing({ target: imageModels.name })
      .returning({ id: imageModels.id });
    return ok(inserted.length);
  }

  async listImageModels(
    tx: Transaction,
    opts?: { userSelectableOnly?: boolean },
  ): Promise<ReadonlyArray<ImageModelRow>> {
    const where = opts?.userSelectableOnly ? eq(imageModels.userSelectable, true) : undefined;
    const query = tx.select().from(imageModels).orderBy(asc(imageModels.name));
    return where ? query.where(where) : query;
  }

  async listImageModelsWithProvider(
    tx: Transaction,
    opts?: { userSelectableOnly?: boolean },
  ): Promise<ReadonlyArray<ImageModelWithProvider>> {
    const rows = await tx
      .select({ model: imageModels, provider: imageProviders })
      .from(imageModels)
      .innerJoin(imageProviders, eq(imageModels.providerId, imageProviders.id))
      .where(opts?.userSelectableOnly ? eq(imageModels.userSelectable, true) : undefined)
      .orderBy(asc(imageModels.name));
    return rows.map((r) => ({ ...r.model, provider: r.provider }));
  }

  async deleteImageModel(tx: Transaction, modelId: string): Promise<void> {
    await tx.delete(imageModels).where(eq(imageModels.id, modelId));
  }
}
