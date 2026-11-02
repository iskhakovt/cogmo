import { ok } from "neverthrow";
import { match } from "ts-pattern";
import { z } from "zod";
import { defineTool, reject, type ToolSpec } from "../agent/tools.js";

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

   If the skill needs the network, say so in the goal and have it use \`await ctx.http.get(url)\` — tier 1 has no sockets, so \`urllib\`/\`httpx\`/\`requests\` are rejected at register time. It returns \`{"status", "headers", "body"}\` and needs no dependency. The manifest must also list every host reached through \`ctx.http\` under \`network.allow\`, or that request is refused (tier 2's raw \`httpx\` has real sockets and is not bound by it); a skill declaring both a secret and a network allowlist always needs the user's approval before it goes live.
2. When the task opens its PR, Cogmo registers the branch itself and the user receives the outcome message; don't call \`register_skill\` for it. \`register_skill\` is for a skills-repo branch that arrived some other way (the user pushed it and asked). The classifier tiers every deploy, and nothing deploys silently. A \`notify\` skill goes live at once, and the user gets a message listing what it declares, with a Disable button. An \`approve\` skill — tier \`container\`, an acting effect (sending, deleting, writing files, financial or a subprocess), a secret together with a network allowlist, three or more secrets, or a dependency on the approve list — waits until the user taps Approve on the message they receive.
3. The new skill appears as its own LLM tool from your *next turn onwards* (the tool list is rebuilt each turn from the live-skill rows). You can then call it like any built-in tool.

Register only a branch the user asked you to register this conversation — the user owns the deploy decision for unfamiliar branches. If the register is rejected (manifest invalid, branch missing, non-fast-forward), surface the error verbatim and ask for guidance.`;

export const registerSkillTool: ToolSpec = defineTool({
  name: "register_skill",
  description:
    "Register a skill from a feature branch in the skills repo that reached it outside a coding " +
    "task (a coding task's branch is registered when its PR opens). The branch tip must contain " +
    "SKILL.md (manifest) + skill.py (entrypoint). On success the skill is live, appearing as its " +
    "own tool on your next turn, or awaits the user's approval.",
  // Durable: registration compiles and deploys the skill (sandbox work +
  // git state). Exactly-once per turn, not once per step boundary after
  // the call.
  durable: true,
  schema: RegisterSkillInput,
  handler: async ({ branch }, service) => {
    if (!service.skills) {
      return reject(
        "Skills runtime is unavailable in this build — bootstrap missing skillRunner wiring.",
      );
    }
    const result = await service.skills.register({ branch });
    if (result.status === "rejected") {
      return reject(
        `Register rejected: ${result.errors.join("; ") || "no reason given"}. ` +
          "Surface the errors verbatim and ask the user for guidance.",
      );
    }
    return ok(
      JSON.stringify({
        status: result.status,
        name: result.name || undefined,
        riskTier: result.riskTier,
        gitSha: result.gitSha,
        ...match(result)
          .returnType<{ deployId?: string }>()
          .with({ status: "live" }, { status: "pending_approval" }, (deployed) => ({
            deployId: deployed.deployId,
          }))
          .with({ status: "no_op" }, () => ({}))
          .exhaustive(),
        nextStep: match(result.status)
          .with(
            "live",
            () =>
              `Skill '${result.name}' is live. It appears as its own tool starting next turn — don't try to call it inside this turn (the tool list was already built).`,
          )
          .with(
            "pending_approval",
            () =>
              `Skill '${result.name}' is awaiting user approval. Tell the user a deploy is pending; they'll receive an approval prompt.`,
          )
          .with(
            "no_op",
            () => `Skill '${result.name}' branch tip already matches main — nothing to deploy.`,
          )
          .exhaustive(),
      }),
    );
  },
});
