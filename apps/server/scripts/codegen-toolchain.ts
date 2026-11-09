/**
 * Write the skills repo toolchain's generated files
 * (`src/skills/toolchain-codegen.ts`): `pnpm --filter cogmo codegen:toolchain`.
 */
import { mkdirSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import {
  GENERATED_TOOLCHAIN_FILES,
  readToolchainPins,
  renderSkillManifestSchema,
  renderToolchainClaudeMd,
  renderToolchainPaths,
  renderToolchainPyproject,
} from "../src/skills/toolchain-codegen.js";

const repoRoot = join(dirname(fileURLToPath(import.meta.url)), "../../..");

for (const [path, contents] of [
  [GENERATED_TOOLCHAIN_FILES.pyproject, renderToolchainPyproject(readToolchainPins(repoRoot))],
  [GENERATED_TOOLCHAIN_FILES.claudeMd, renderToolchainClaudeMd()],
  [GENERATED_TOOLCHAIN_FILES.manifestSchema, renderSkillManifestSchema()],
  [GENERATED_TOOLCHAIN_FILES.paths, renderToolchainPaths()],
] as const) {
  const target = join(repoRoot, path);
  mkdirSync(dirname(target), { recursive: true });
  writeFileSync(target, contents);
  console.log(`wrote ${path}`);
}
