/**
 * Write the files generated from the ctx contract and the worker protocol
 * (`src/skills/ctx-contract-codegen.ts`): `pnpm --filter cogmo codegen:ctx`.
 */
import { mkdirSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import {
  GENERATED_CONTRACT_FILES,
  renderContractSchema,
  renderPythonContract,
} from "../src/skills/ctx-contract-codegen.js";

const repoRoot = join(dirname(fileURLToPath(import.meta.url)), "../../..");

for (const [path, contents] of [
  [GENERATED_CONTRACT_FILES.schema, renderContractSchema()],
  [GENERATED_CONTRACT_FILES.python, renderPythonContract()],
] as const) {
  const target = join(repoRoot, path);
  mkdirSync(dirname(target), { recursive: true });
  writeFileSync(target, contents);
  console.log(`wrote ${path}`);
}
