declare module "vitest" {
  export interface ProvidedContext {
    databaseUrl: string;
    inngestBaseUrl: string;
    inngestEventKey: string;
  }
}
