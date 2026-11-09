import type { SkillsRepo } from "../skills/skill-files.js";

/** The skills repo at `path` with `layoutCommitSha` as its recorded layout commit. */
export function skillsRepoAt(path: string, layoutCommitSha: string): SkillsRepo {
  return { path, layoutCommitSha: async () => layoutCommitSha };
}
