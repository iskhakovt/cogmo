/// <reference types="vite/client" />

interface ImportMetaEnv {
  /**
   * Dev-only absolute backend origin for the chat SSE stream when the SPA is
   * served by the Vite dev server (cross-origin). Empty/undefined in prod, where
   * the SPA is same-origin. Set by `dev-infra.ts` for the Vite child.
   */
  readonly VITE_SSE_BASE_URL?: string;
}

interface ImportMeta {
  readonly env: ImportMetaEnv;
}
