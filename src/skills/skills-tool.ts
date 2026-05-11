import { z } from "zod";
import { defineTool, type ToolSpec } from "../agent/tools.js";

const RegisterSkillInput = z.object({
  branch: z
    .string()
    .min(1)
    .describe(
      "Feature branch name in the skills repo (e.g. 'skill/summarize-email-2026-04-30'). " +
        "The branch tip must contain SKILL.md + skill.py and be a fast-forward of main.",
    ),
});

export const SKILLS_PROMPT_GUIDANCE = `You can author Python skills — small programs that become tools you can call later. Workflow:

1. Use \`delegate_coding\` against the skills repo — it's registered as \`skills\` automatically on every boot, no \`/repo add\` needed. The goal should describe both the SKILL.md (manifest: name, description, tier, inputs, effects) and the skill.py (a single \`async def run(inputs, ctx) -> dict\`). Wait for the user to approve and the task to finish.
2. Once Claude Code finishes and pushes the feature branch, call \`register_skill\` with the branch name. The classifier (currently stub) tags every skill 'notify'-tier — registration goes through immediately and the user receives a one-line notification that the skill is now live.
3. The new skill appears as its own LLM tool from your *next turn onwards* (the tool list is rebuilt each turn from the live-skill rows). You can then call it like any built-in tool.

Don't try to register skills you didn't author this conversation — the user owns the deploy decision for unfamiliar branches. If the register is rejected (manifest invalid, branch missing, non-fast-forward), surface the error verbatim and ask for guidance.`;

export const registerSkillTool: ToolSpec = defineTool({
  name: "register_skill",
  description:
    "Register a skill from a freshly-pushed feature branch in the skills repo. The branch tip " +
    "must contain SKILL.md (manifest) + skill.py (entrypoint). On success the skill is live and " +
    "appears as its own tool on your next turn. Use after delegate_coding finishes a skill " +
    "authoring task.",
  schema: RegisterSkillInput,
  handler: async ({ branch }, service) => {
    if (!service.skills) {
      throw new Error(
        "Skills runtime is unavailable in this build — bootstrap missing skillRunner wiring.",
      );
    }
    const result = await service.skills.register({ branch });
    return JSON.stringify({
      status: result.status,
      name: result.name || undefined,
      riskTier: result.riskTier,
      gitSha: result.gitSha,
      ...(result.errors && result.errors.length > 0 && { errors: result.errors }),
      ...(result.pendingId && { pendingId: result.pendingId }),
      nextStep:
        result.status === "live"
          ? `Skill '${result.name}' is live. It appears as its own tool starting next turn — don't try to call it inside this turn (the tool list was already built).`
          : result.status === "pending_approval"
            ? `Skill '${result.name}' is awaiting user approval. Tell the user a deploy is pending; they'll receive an approval prompt.`
            : result.status === "no_op"
              ? `Skill '${result.name}' branch tip already matches main — nothing to deploy.`
              : "Register rejected; surface the errors verbatim and ask the user for guidance.",
    });
  },
});
