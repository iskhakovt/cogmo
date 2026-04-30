/** Skills module public surface. */

export { classifyManifest, STUB_CLASSIFIER_VERSION } from "./classifier.js";
export { runSkillsCli } from "./cli.js";
export type { ManifestParseError, ParsedManifest } from "./manifest.js";
export { parseManifest } from "./manifest.js";
export { bootstrapSkillsRepo } from "./repo.js";
export {
  InputValidationError,
  type RegisterResult,
  type SkillRunner,
  SkillRunnerImpl,
  type SkillRunResult,
  type SkillSummary,
  type SkillToolDef,
} from "./runner.js";
export { buildSkillToolSpec, buildSkillTools } from "./skill-tool-builder.js";
export { createSkillsService, type SkillsService } from "./skills-service.js";
export { registerSkillTool, SKILLS_PROMPT_GUIDANCE } from "./skills-tool.js";
export { DrizzleSkillStore, type SkillStore } from "./store/index.js";
export {
  ClassifierLogSchema,
  SKILL_EFFECTS,
  type SkillEffect,
  type SkillManifest,
  SkillManifestSchema,
} from "./types.js";
