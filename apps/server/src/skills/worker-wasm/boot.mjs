// Worker boot wrapper for source runs (dev, tests). `host.ts` loaded from
// `src/` spawns this file, which registers tsx's ESM loader inside the
// worker thread and then imports the TypeScript worker-entry. The build
// doesn't ship it: the bundled host spawns `dist/worker-entry.js` directly.
// register() runs only from a `src/` checkout, where tsx is installed.
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
