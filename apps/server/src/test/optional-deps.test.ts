import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { parse as parseYaml } from "yaml";
import { z } from "zod";
import { repoRoot } from "./repo-root.js";

/**
 * Optional-dependency guard for the runtime image.
 *
 * The runtime stage deploys with `pnpm deploy --prod` and keeps optional
 * dependencies, since sharp's platform binaries are optional dependencies and
 * nothing else installs them (design/infrastructure.md → Image processing).
 * That also ships every other optional dependency in the production graph, so
 * a dependency bump could add one to the image unnoticed. This pins the set:
 * the packages the lockfile reaches from the server's production dependencies
 * only through an optional edge, by name. A new one fails here; add it to the
 * list once it is wanted in the image, or drop it with a workspace override.
 */

/**
 * What the production graph may reach only through an optional edge. A
 * trailing `*` allows a family of platform binaries, of which an install
 * keeps the one for its platform. The lockfile over-approximates the image:
 * pnpm resolves an optional peer the workspace already has (TypeScript,
 * PGlite) without deploying it.
 */
const ALLOWED_OPTIONAL_ONLY: ReadonlyArray<string> = [
  // sharp's prebuilt binaries, the reason the image keeps optional
  // dependencies; the wasm builds need `@emnapi/runtime`.
  "@img/sharp-*",
  "@emnapi/runtime",
  // Optional peers resolved to the workspace's copies: drizzle-orm's PGlite
  // driver, the native TypeScript compiler (@t3-oss/env-core, inngest,
  // ts-essentials), React (inngest; the web app's).
  "@electric-sql/pglite",
  "typescript",
  "@typescript/typescript-*",
  "react",
  // A Rollup binary neverthrow lists for its build.
  "@rollup/rollup-linux-x64-gnu",
  // ssh2's optional native speed-ups, not built (`allowBuilds`).
  "cpu-features",
  "buildcheck",
  "nan",
  // debug's colour detection, and jackspeak's argument parser.
  "supports-color",
  "has-flag",
  "@pkgjs/parseargs",
];

function matches(entry: string, name: string): boolean {
  return entry.endsWith("*") ? name.startsWith(entry.slice(0, -1)) : name === entry;
}

function allowed(name: string): boolean {
  return ALLOWED_OPTIONAL_ONLY.some((entry) => matches(entry, name));
}

const DependencyMapSchema = z.record(z.string(), z.string()).optional();

const LockfileSchema = z.object({
  importers: z.record(
    z.string(),
    z.object({
      dependencies: z
        .record(z.string(), z.object({ version: z.string() }).passthrough())
        .optional(),
      optionalDependencies: z
        .record(z.string(), z.object({ version: z.string() }).passthrough())
        .optional(),
    }),
  ),
  snapshots: z.record(
    z.string(),
    z
      .object({ dependencies: DependencyMapSchema, optionalDependencies: DependencyMapSchema })
      .passthrough(),
  ),
});
type Lockfile = z.infer<typeof LockfileSchema>;

const SERVER_IMPORTER = "apps/server";

interface Edge {
  name: string;
  version: string;
  optional: boolean;
}

/** A resolved version as a snapshot key, or the importer a workspace link points at. */
function target(
  from: string,
  { name, version }: Edge,
): { snapshot: string } | { importer: string } {
  if (version.startsWith("link:")) return { importer: join(from, version.slice("link:".length)) };
  // An alias (`wrap-ansi-cjs: wrap-ansi@7.0.0`) resolves to the package it names.
  return { snapshot: /^\d/.test(version) ? `${name}@${version}` : version };
}

function importerEdges(lockfile: Lockfile, importer: string): Edge[] {
  const entry = lockfile.importers[importer];
  if (entry === undefined) throw new Error(`importer ${importer} missing from the lockfile`);
  return [
    ...Object.entries(entry.dependencies ?? {}).map(([name, d]) => ({
      name,
      version: d.version,
      optional: false,
    })),
    ...Object.entries(entry.optionalDependencies ?? {}).map(([name, d]) => ({
      name,
      version: d.version,
      optional: true,
    })),
  ];
}

function snapshotEdges(lockfile: Lockfile, key: string): Edge[] {
  const entry = lockfile.snapshots[key];
  if (entry === undefined) throw new Error(`snapshot ${key} missing from the lockfile`);
  return [
    ...Object.entries(entry.dependencies ?? {}).map(([name, version]) => ({
      name,
      version,
      optional: false,
    })),
    ...Object.entries(entry.optionalDependencies ?? {}).map(([name, version]) => ({
      name,
      version,
      optional: true,
    })),
  ];
}

/** Package names the server's production graph reaches, following optional edges or not. */
function reachable(lockfile: Lockfile, followOptional: boolean): Set<string> {
  const names = new Set<string>();
  const seen = new Set<string>();
  const queue: Array<{ snapshot: string } | { importer: string }> = [{ importer: SERVER_IMPORTER }];
  while (queue.length > 0) {
    const next = queue.pop();
    if (next === undefined) break;
    const id = "snapshot" in next ? next.snapshot : `importer:${next.importer}`;
    if (seen.has(id)) continue;
    seen.add(id);
    const from = "importer" in next ? next.importer : "";
    const edges =
      "snapshot" in next ? snapshotEdges(lockfile, next.snapshot) : importerEdges(lockfile, from);
    for (const edge of edges) {
      if (edge.optional && !followOptional) continue;
      names.add(edge.name);
      queue.push(target(from, edge));
    }
  }
  return names;
}

describe("optional dependencies in the runtime image", () => {
  const lockfile = LockfileSchema.parse(
    parseYaml(readFileSync(join(repoRoot(), "pnpm-lock.yaml"), "utf8")),
  );

  it("are exactly the allowed ones", () => {
    const required = reachable(lockfile, false);
    // Guards the guard: a lockfile shape the schema misreads would otherwise
    // reach nothing and pass vacuously.
    expect(required.size).toBeGreaterThan(200);
    const optionalOnly = [...reachable(lockfile, true)].filter((name) => !required.has(name));
    expect(optionalOnly.filter((name) => !allowed(name))).toEqual([]);
    // An entry nothing matches any more is stale.
    expect(
      ALLOWED_OPTIONAL_ONLY.filter((entry) => !optionalOnly.some((name) => matches(entry, name))),
    ).toEqual([]);
  });
});
