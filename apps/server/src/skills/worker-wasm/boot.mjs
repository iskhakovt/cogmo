// Worker boot wrapper for source runs (dev, tests). `host.ts` loaded from
// `src/` spawns this file, which registers tsx's ESM loader inside the
// worker thread and then imports the TypeScript worker-entry. The build
// doesn't ship it: the bundled host spawns `dist/worker-entry.js` directly.
import { register } from "tsx/esm/api";

register();
// Dynamic, so it loads after register(): a static import would load before
// any of this module's code runs.
await import("./worker-entry.ts");
