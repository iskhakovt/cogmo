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
