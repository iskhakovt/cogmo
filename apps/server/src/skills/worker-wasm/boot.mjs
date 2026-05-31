// Worker boot wrapper. Loads the TypeScript worker-entry by registering
// tsx's ESM loader inside this worker thread. In production (post-tsup
// build) this file lives next to worker-entry.js and tsx isn't installed,
// so the import will resolve to the compiled .js sibling — but we keep
// the register() call gated so production doesn't try to load tsx.
const isSource = import.meta.url.includes("/src/");
if (isSource) {
  const { register } = await import("tsx/esm/api");
  register();
}
// `"./worker-entry.ts" + ""` defeats tsup/esbuild's static dynamic-import
// analyzer — without the concat, the bundler tries to bundle the .ts as
// part of this .mjs and breaks the loader. Equivalent in spirit to
// vite-ignore / webpackIgnore comments, but esbuild has no such directive
// today (see evanw/esbuild#700). Don't simplify.
await import("./worker-entry.ts" + "");
