/** Skills module public surface. */
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
} from "./runner.js";
export { DrizzleSkillStore, type SkillStore } from "./store/index.js";
export {
  ClassifierLogSchema,
  SKILL_EFFECTS,
  type SkillEffect,
  type SkillManifest,
  SkillManifestSchema,
} from "./types.js";
