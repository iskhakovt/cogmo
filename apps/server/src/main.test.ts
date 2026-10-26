/**
 * Runs `src/main.ts` as a subprocess with no environment beyond `PATH` and
 * `NODE_ENV`: each command group reaches its own tree, the built-in commands
 * parse without a configured runtime, and logs reach the stream picked for the
 * command. Every case exits before a handler needs the database.
 */

import { spawn } from "node:child_process";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

const PACKAGE_ROOT = fileURLToPath(new URL("..", import.meta.url));

const EXIT_LINE = "logged on exit";

/**
 * Preloaded ahead of `src/main.ts`: logs {@link EXIT_LINE} through `logger`
 * as the command exits, after the entrypoint has chosen where logs go. Every
 * command that logs on its own needs Postgres, which this tier doesn't run.
 */
const LOG_ON_EXIT = `data:text/javascript,${encodeURIComponent(`
  import { logger } from ${JSON.stringify(new URL("logger.ts", import.meta.url).href)};
  const exit = process.exit;
  process.exit = (code) => {
    logger.info(${JSON.stringify(EXIT_LINE)});
    return exit(code);
  };
`)}`;

interface Exit {
  code: number | null;
  stdout: string;
  stderr: string;
}

function cogmo(...args: string[]): Promise<Exit> {
  return launch([], {}, args);
}

/** `cogmo` with {@link LOG_ON_EXIT} preloaded, under `NODE_ENV=nodeEnv`. */
function cogmoLogging(nodeEnv: string, ...args: string[]): Promise<Exit> {
  return launch(["--import", LOG_ON_EXIT], { NODE_ENV: nodeEnv }, args);
}

function launch(
  nodeArgs: readonly string[],
  env: Readonly<Record<string, string>>,
  args: readonly string[],
): Promise<Exit> {
  return new Promise((resolve, reject) => {
    const proc = spawn(process.execPath, ["--import", "tsx", ...nodeArgs, "src/main.ts", ...args], {
      cwd: PACKAGE_ROOT,
      env: { PATH: process.env.PATH, ...env },
    });
    let stdout = "";
    let stderr = "";
    proc.stdout.on("data", (chunk) => {
      stdout += chunk;
    });
    proc.stderr.on("data", (chunk) => {
      stderr += chunk;
    });
    proc.on("error", reject);
    proc.on("close", (code) => resolve({ code, stdout, stderr }));
  });
}

/** Each group, a command line reaching into its tree, and what only that tree's help shows. */
const GROUPS: ReadonlyArray<readonly [string, readonly string[], string]> = [
  ["provider", ["set", "--help"], "--cache-dialect"],
  ["model", ["add", "--help"], "--max-output"],
  ["subagent", ["add", "--help"], "--system-prompt"],
  ["image-provider", ["add", "--help"], "--cfg-scale"],
  ["image-model", ["add", "--help"], "--model-string"],
  ["skills", ["run", "--help"], "<jsonInputs>"],
  ["migrate-memories", ["--help"], "[bankId]"],
  ["backfill", ["profile-class", "--help"], "--tag"],
  ["migrate-skills-remote", ["--help"], "skills repo"],
];

describe.concurrent("cogmo entrypoint", { timeout: 60_000 }, () => {
  it.each(GROUPS)("dispatches `%s` to its own command tree", async (group, argv, marker) => {
    const { code, stdout } = await cogmo(group, ...argv);

    expect(code).toBe(0);
    expect(stdout).toMatch(new RegExp(`^cogmo ${group}\\b`));
    expect(stdout).toContain(marker);
  });

  it("lists every command in its help", async () => {
    const { code, stdout } = await cogmo("--help");

    expect(code).toBe(0);
    const groups = GROUPS.map(([group]) => group);
    for (const name of ["serve", "seed", "setup", "gen-key", "web-token", ...groups]) {
      expect(stdout).toContain(`- ${name} - `);
    }
  });

  it("suggests the command a typo meant", async () => {
    const { code, stderr } = await cogmo("provder");

    expect(code).toBe(2);
    expect(stderr).toContain("Did you mean provider?");
  });

  it("prints a master key", async () => {
    const { code, stdout } = await cogmo("gen-key");

    expect(code).toBe(0);
    expect(stdout).toMatch(/^COGMO_MASTER_KEY=\S+$/m);
  });

  it.each(["production", "development"])(
    "logs a command to stderr, leaving stdout to its output (NODE_ENV=%s)",
    async (nodeEnv) => {
      const { code, stdout, stderr } = await cogmoLogging(nodeEnv, "gen-key");

      expect(code).toBe(0);
      expect(stdout).toMatch(/^COGMO_MASTER_KEY=\S+$/m);
      expect(stdout).not.toContain(EXIT_LINE);
      expect(stderr).toContain(EXIT_LINE);
    },
  );

  it("logs `serve` to stdout", async () => {
    const { code, stdout, stderr } = await cogmoLogging("production", "serve", "--help");

    expect(code).toBe(0);
    expect(stdout).toContain(EXIT_LINE);
    expect(stderr).not.toContain(EXIT_LINE);
  });

  it("refuses to print a web token without the master key", async () => {
    const { code, stderr } = await cogmo("web-token");

    expect(code).toBe(1);
    expect(stderr).toContain("COGMO_MASTER_KEY is required");
  });

  it("rejects an unknown setup --reset scope before setup runs", async () => {
    const { code, stderr } = await cogmo("setup", "--reset", "bogus");

    expect(code).toBe(2);
    expect(stderr).toContain(
      "Invalid value 'bogus'. Expected one of: 'secrets', 'channels', 'all'",
    );
  });

  it("documents setup's options", async () => {
    const { code, stdout } = await cogmo("setup", "--help");

    expect(code).toBe(0);
    expect(stdout).toContain("--reset <scope>");
    expect(stdout).toContain("--non-interactive");
  });
});
