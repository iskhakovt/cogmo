import type { SecretsStore } from "./store/index.js";

/**
 * Resolves credentials from DB first, env as fallback.
 *
 * The mapping connects DB secret names to env var names so the resolver
 * knows where to fall back. Example: `"anthropic_api_key" → "ANTHROPIC_API_KEY"`.
 */
export interface ConfigResolver {
  /** Get a secret value — DB first, env fallback. */
  getSecret(name: string): Promise<string | null>;
}

export function createConfigResolver(deps: {
  secretsStore: SecretsStore;
  envMapping: ReadonlyMap<string, string>;
}): ConfigResolver {
  const { secretsStore, envMapping } = deps;

  return {
    async getSecret(name: string): Promise<string | null> {
      // DB takes precedence
      const dbValue = await secretsStore.getSecret(name);
      if (dbValue !== null) return dbValue;

      // Env fallback
      const envVar = envMapping.get(name);
      if (envVar) {
        return process.env[envVar] ?? null;
      }

      return null;
    },
  };
}
