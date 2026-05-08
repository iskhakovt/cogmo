// Top-level `export {}` turns this file into a module so the
// `declare module "vitest"` block below augments vitest's existing
// types instead of replacing them. Without it, TypeScript reads it as
// a script and the `declare module` shadows every export from the real
// `vitest` package — `describe`/`expect`/`it`/etc. all start failing
// to resolve in any test file that pulls this d.ts into scope.
export {};

declare module "vitest" {
  export interface ProvidedContext {
    databaseUrl: string;
    inngestBaseUrl: string;
    inngestEventKey: string;
    hindsightUrl: string;
    defaultUserId: string;
    llmockBaseUrl: string;
  }
}
