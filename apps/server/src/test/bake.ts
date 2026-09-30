import { execFile } from "node:child_process";
import { join } from "node:path";
import { promisify } from "node:util";
import { z } from "zod";
import { repoRoot } from "./repo-root.js";

const execFileP = promisify(execFile);

const BakePrintSchema = z.object({
  target: z.record(
    z.string(),
    z.object({
      context: z.string(),
      dockerfile: z.string(),
      args: z.record(z.string(), z.string()).optional(),
      tags: z.array(z.string()).optional(),
    }),
  ),
});

export interface BakeTarget {
  /** Absolute path of the target's Dockerfile. */
  dockerfilePath: string;
  args: Readonly<Record<string, string>>;
  tags: ReadonlyArray<string>;
}

/**
 * A `docker-bake.hcl` target as `docker buildx bake --print` resolves it, so
 * variable defaults, interpolation and environment overrides all apply the
 * way they do for a real bake.
 */
export async function printBakeTarget(target: string): Promise<BakeTarget> {
  const root = repoRoot();
  const { stdout } = await execFileP("docker", ["buildx", "bake", "--print", target], {
    cwd: root,
  });
  const resolved = BakePrintSchema.parse(JSON.parse(stdout)).target[target];
  if (resolved === undefined) throw new Error(`bake printed no target "${target}"`);
  return {
    dockerfilePath: join(root, resolved.context, resolved.dockerfile),
    args: resolved.args ?? {},
    tags: resolved.tags ?? [],
  };
}

const ARG_LINE = /^ARG[ \t]+([A-Za-z_][A-Za-z0-9_]*)(?:=.*)?$/gm;
const SAFE_VALUE = /^[\w.:@/+-]+$/;

/**
 * `dockerfile` with every `ARG` that `args` names given that value as its
 * default, for builders that take a Dockerfile but no build args (Daytona's
 * `Image.fromDockerfile`). Throws on an `ARG` left with no value at all and on
 * an arg the Dockerfile never declares, since either means the result would
 * not build what bake builds.
 */
export function withArgDefaults(
  dockerfile: string,
  args: Readonly<Record<string, string>>,
): string {
  const declared = new Set<string>();
  const result = dockerfile.replace(ARG_LINE, (line, name: string) => {
    declared.add(name);
    const value = args[name];
    if (value === undefined) {
      if (line.includes("=")) return line;
      throw new Error(`ARG ${name} has no default and no value to fill in`);
    }
    if (!SAFE_VALUE.test(value)) throw new Error(`ARG ${name} value ${value} needs quoting`);
    return `ARG ${name}=${value}`;
  });
  const undeclared = Object.keys(args).filter((name) => !declared.has(name));
  if (undeclared.length > 0) {
    throw new Error(`the Dockerfile declares no ARG for ${undeclared.join(", ")}`);
  }
  return result;
}
