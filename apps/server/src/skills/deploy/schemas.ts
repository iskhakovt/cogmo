import { err, ok, type Result } from "neverthrow";
import type { ImportedSchemas } from "../schema-import.js";
import type { SkillManifest, SkillSchemas } from "../types.js";

/**
 * The frontmatter's schemas, the legacy schema path; null when `SKILL.md`
 * declares no `inputs`.
 */
export function frontmatterSchemas(manifest: SkillManifest): SkillSchemas | null {
  return manifest.inputs === undefined
    ? null
    : { inputs: manifest.inputs, outputs: manifest.outputs ?? null };
}

/**
 * The schemas register puts live (design/skills.md → Contracts). On the import
 * path a model is its schema's one source, so the frontmatter may not declare
 * it too; frontmatter `inputs` serves a skill with no `Input` model, and
 * frontmatter `outputs` one with no `Output` model. With `imported` null, the
 * legacy path, the frontmatter's are the schemas.
 */
export function registerSchemas(
  manifest: SkillManifest,
  imported: ImportedSchemas | null,
): Result<SkillSchemas, string[]> {
  if (imported === null) {
    const declared = frontmatterSchemas(manifest);
    return declared === null
      ? err([
          "missing_inputs: SKILL.md declares no inputs, and this deployment cannot import the skill's models",
        ])
      : ok(declared);
  }
  const errors = [
    ...(imported.inputs !== null && manifest.inputs !== undefined
      ? ["inputs_declared_twice: skill.py defines an Input model; remove inputs from SKILL.md"]
      : []),
    ...(imported.outputs !== null && manifest.outputs !== undefined
      ? ["outputs_declared_twice: skill.py defines an Output model; remove outputs from SKILL.md"]
      : []),
  ];
  const inputs = imported.inputs ?? manifest.inputs;
  if (inputs === undefined) {
    errors.push("missing_inputs: define an Input model in skill.py or inputs in SKILL.md");
  }
  if (errors.length > 0 || inputs === undefined) return err(errors);
  return ok({ inputs, outputs: imported.outputs ?? manifest.outputs ?? null });
}
