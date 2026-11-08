import { z } from "zod";

/** What a child that loads a skill boots with. */
const SkillChildShape = {
  /** The real path of the `pyodide` package directory. */
  pyodideDistDir: z.string().min(1),
  /** Pyodide's package cache, the only place the child loads built-ins from. */
  packageCacheDir: z.string().min(1),
  /** Pyodide built-ins to load from the cache before the skill loads. */
  builtins: z.array(z.string().min(1)),
  /** The read-only directory of the lockfile's wheels, or null for none. */
  wheelDir: z.string().min(1).nullable(),
  /** WebAssembly memory ceiling, in MiB. */
  memoryMb: z.number().int().positive(),
  /** Source of `skill.py`. */
  body: z.string(),
};

/**
 * What a wasm child is told to do, sent as its first IPC message: run one
 * skill task, import a skill to read its models' JSON Schemas, or probe that
 * built-in packages load under the boundary, from the package cache the host
 * filled and verified. The child's main thread hands it to its Pyodide worker
 * thread unread. design/skills.md → Wasm-tier boundary.
 */
export const ChildInitSchema = z.discriminatedUnion("mode", [
  z.object({ mode: z.literal("run"), ...SkillChildShape }),
  z.object({ mode: z.literal("schema"), ...SkillChildShape }),
  z.object({
    mode: z.literal("probe"),
    pyodideDistDir: z.string().min(1),
    packageCacheDir: z.string().min(1),
    names: z.array(z.string().min(1)),
  }),
]);
export type ChildInit = z.infer<typeof ChildInitSchema>;

/** A `probe` child's one reply: every package that did not load and import. */
export const ProbeReplySchema = z.discriminatedUnion("type", [
  z.object({
    type: z.literal("probed"),
    failures: z.array(z.object({ name: z.string(), reason: z.string() })),
  }),
  z.object({ type: z.literal("fatal"), error: z.string() }),
]);
