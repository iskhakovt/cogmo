/**
 * `cogmo skills <command>` — list and invoke skills, and move deploys through
 * register / approve / deny / rollback / deregister as the install owner.
 */

import {
  command,
  extendType,
  positional,
  restPositionals,
  string,
  subcommands,
  type Type,
} from "cmd-ts";
import type { SkillRunAs } from "../skills/run-as.js";
import {
  describeInvokeRejection,
  type RegisterResult,
  type SkillDeployOrigin,
  type SkillRunner,
} from "../skills/runner.js";
import { identifier } from "./args.js";
import type { CliIo, LoadDeps } from "./run.js";

export interface SkillsCliDeps {
  runner: SkillRunner;
  /** The install owner with the default profile — whom `run` runs as. */
  ownerRunAs(): Promise<SkillRunAs>;
}

/** The CLI is the operator's: a schedule it puts live runs as the owner. */
const OWNER: SkillDeployOrigin = { kind: "owner" };

/** Any JSON value; the runner validates it against the skill's input schema. */
const jsonInputs: Type<string, unknown> = extendType(string, {
  displayName: "jsonInputs",
  async from(value): Promise<unknown> {
    try {
      return JSON.parse(value);
    } catch (e) {
      throw new Error(`invalid JSON inputs: ${e instanceof Error ? e.message : String(e)}`);
    }
  },
});

function skillName(description: string) {
  return positional({ type: identifier("name"), displayName: "name", description });
}

function pendingId() {
  return positional({
    type: identifier("pendingId"),
    displayName: "pendingId",
    description: "A pending-approval deploy's id.",
  });
}

export function skillsCli(io: CliIo, loadDeps: LoadDeps<SkillsCliDeps>) {
  return subcommands({
    name: "skills",
    description: "Manage and invoke skills.",
    cmds: {
      list: command({
        name: "list",
        description: "List enabled skills (name, tier, risk, disabled, git_sha).",
        args: {},
        handler: async () => listSkills(await loadDeps(), io),
      }),
      run: command({
        name: "run",
        description: "Invoke a skill as the install owner with the default profile.",
        args: {
          name: skillName("The skill."),
          inputs: positional({
            type: jsonInputs,
            displayName: "jsonInputs",
            description: "Its inputs as one JSON argument.",
          }),
        },
        examples: [{ description: "Invoke echo", command: `cogmo skills run echo '{"x":1}'` }],
        handler: async (args) => runSkill(args, await loadDeps(), io),
      }),
      register: command({
        name: "register",
        description: "Classify a feature branch in the skills repo and merge it.",
        args: {
          branch: positional({
            type: identifier("branch"),
            displayName: "branch",
            description: "The feature branch.",
          }),
        },
        handler: async ({ branch }) => {
          const { runner } = await loadDeps();
          return printDeploy(await runner.register({ branch, origin: OWNER }), io);
        },
      }),
      approve: command({
        name: "approve",
        description: "Approve a pending-approval deploy.",
        args: { pendingId: pendingId() },
        handler: async ({ pendingId }) => {
          const { runner } = await loadDeps();
          return printDeploy(await runner.approveDeploy({ pendingId, origin: OWNER }), io);
        },
      }),
      deny: command({
        name: "deny",
        description: "Deny a pending-approval deploy.",
        args: {
          pendingId: pendingId(),
          reason: restPositionals({
            type: string,
            displayName: "reason",
            description: "Why, as the remaining words.",
          }),
        },
        handler: async (args) => denyDeploy(args, await loadDeps(), io),
      }),
      rollback: command({
        name: "rollback",
        description: "Rewind a skill's git_sha to a prior commit.",
        args: {
          name: skillName("The skill."),
          toGitSha: positional({
            type: identifier("toGitSha"),
            displayName: "toGitSha",
            description: "The commit to rewind to.",
          }),
        },
        handler: async ({ name, toGitSha }) => {
          const { runner } = await loadDeps();
          return printDeploy(await runner.rollback({ name, toGitSha, origin: OWNER }), io);
        },
      }),
      deregister: command({
        name: "deregister",
        description: "Soft-disable a skill, keeping its audit history.",
        args: { name: skillName("The skill.") },
        handler: async (args) => deregisterSkill(args, await loadDeps(), io),
      }),
    },
  });
}

async function listSkills(deps: SkillsCliDeps, io: CliIo): Promise<number> {
  const skills = await deps.runner.list();
  if (skills.length === 0) {
    io.out("(no enabled skills)");
    return 0;
  }
  io.out("name\ttier\trisk\tdisabled\tgit_sha");
  for (const s of skills) {
    io.out([s.name, s.tier, s.riskTier, s.disabled ? "yes" : "no", s.gitSha].join("\t"));
  }
  return 0;
}

async function runSkill(
  args: { name: string; inputs: unknown },
  deps: SkillsCliDeps,
  io: CliIo,
): Promise<number> {
  const { name, inputs } = args;
  try {
    const runAs = await deps.ownerRunAs();
    const invoked = await deps.runner.invoke({ name, inputs, trigger: "manual", runAs });
    if (invoked.isErr()) {
      io.err(`invoke failed: ${describeInvokeRejection(invoked.error)}`);
      return 1;
    }
    const result = invoked.value;
    io.out(JSON.stringify(result, null, 2));
    return result.status === "success" ? 0 : 1;
  } catch (e) {
    io.err(`invoke failed: ${e instanceof Error ? e.message : String(e)}`);
    return 1;
  }
}

function printDeploy(result: RegisterResult, io: CliIo): number {
  io.out(JSON.stringify(result, null, 2));
  return result.status === "rejected" ? 1 : 0;
}

async function denyDeploy(
  args: { pendingId: string; reason: string[] },
  deps: SkillsCliDeps,
  io: CliIo,
): Promise<number> {
  const { pendingId } = args;
  const reason = args.reason.length > 0 ? args.reason.join(" ") : undefined;
  await deps.runner.denyDeploy({ pendingId, ...(reason !== undefined && { reason }) });
  io.out(JSON.stringify({ pendingId, status: "denied", reason: reason ?? null }, null, 2));
  return 0;
}

async function deregisterSkill(
  args: { name: string },
  deps: SkillsCliDeps,
  io: CliIo,
): Promise<number> {
  const result = await deps.runner.deregister({ name: args.name });
  if (result.kind === "rejected") {
    io.err(`deregister failed: skill not found: ${result.name}`);
    return 1;
  }
  io.out(JSON.stringify({ name: result.name, status: "disabled" }, null, 2));
  return 0;
}
