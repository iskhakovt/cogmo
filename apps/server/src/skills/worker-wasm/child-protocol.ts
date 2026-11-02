import { z } from "zod";

/**
 * What a tier-1 child is told to do, sent as its first IPC message: run one
 * skill task, fill the package cache, or probe that built-in packages load
 * under the boundary. The child's main thread hands it to its Pyodide worker
 * thread unread. design/skills.md → Tier-1 boundary.
 */
export const ChildInitSchema = z.discriminatedUnion("mode", [
  z.object({
    mode: z.literal("run"),
    /** The real path of the `pyodide` package directory. */
    pyodideDistDir: z.string().min(1),
    /** Null: Pyodide's own default, the distribution directory. */
    packageCacheDir: z.string().min(1).nullable(),
    /** Pyodide built-ins to load from the cache before the skill runs. */
    builtins: z.array(z.string().min(1)),
    /** The read-only directory of the lockfile's wheels, or null for none. */
    wheelDir: z.string().min(1).nullable(),
    /** WebAssembly memory ceiling, in MiB. */
    memoryMb: z.number().int().positive(),
    /** Source of `skill.py`. */
    body: z.string(),
  }),
  z.object({
    mode: z.literal("prefetch"),
    pyodideDistDir: z.string().min(1),
    packageCacheDir: z.string().min(1),
    names: z.array(z.string().min(1)),
  }),
  z.object({
    mode: z.literal("probe"),
    pyodideDistDir: z.string().min(1),
    packageCacheDir: z.string().min(1),
    names: z.array(z.string().min(1)),
  }),
]);
export type ChildInit = z.infer<typeof ChildInitSchema>;

/** A `prefetch` child's one reply. */
export const PrefetchReplySchema = z.discriminatedUnion("type", [
  z.object({ type: z.literal("prefetched") }),
  z.object({ type: z.literal("fatal"), error: z.string() }),
]);

/** A `probe` child's one reply: every package that did not load and import. */
export const ProbeReplySchema = z.discriminatedUnion("type", [
  z.object({
    type: z.literal("probed"),
    failures: z.array(z.object({ name: z.string(), reason: z.string() })),
  }),
  z.object({ type: z.literal("fatal"), error: z.string() }),
]);
