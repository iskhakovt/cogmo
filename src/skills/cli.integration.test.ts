/// <reference path="../../test/vitest.d.ts" />

/**
 * Spawns `node ... main.ts skills <subcommand>` as a subprocess against the
 * integration stack — validates the bootstrap → CLI handoff that unit tests
 * can't cover (env resolution, DB connection lifecycle, process.exit code,
 * stdout/stderr stream segregation).
 *
 * Skill seeding goes through the real `__registerForTests` via a sibling
 * subprocess that imports the bootstrap module — same boundary the CLI uses.
 */

import { spawn } from "node:child_process";
import { randomBytes } from "node:crypto";
import postgres from "postgres";
import { beforeAll, describe, expect, inject, it } from "vitest";
import { deriveMasterKey, encrypt, parseMasterKey, toBase64 } from "../secrets/encryption.js";

const SUITE = randomBytes(4).toString("hex");
const skillName = (tag: string) => `it-${SUITE}-${tag}`;

/**
 * The CLI subprocess goes through `bootstrap()`, which calls
 * `resolveProviderForModel(profile.model, ...)`. The integration setup seeds
 * a default user + profile but no provider, so the CLI would die before
 * reaching the skills handler. Insert a stub provider + model routing row
 * directly via SQL — same trick `e2e-setup.ts` uses.
 *
 * The provider is never called by skill execution (skills don't go through
 * the LLM), so the API key value is irrelevant.
 */
async function seedStubProvider(): Promise<void> {
  const masterKey = process.env.COGMO_MASTER_KEY;
  if (!masterKey) throw new Error("COGMO_MASTER_KEY unset");
  const key = deriveMasterKey(parseMasterKey(masterKey), "cogmo/secrets-at-rest/v1");
  const { ciphertext, nonce } = encrypt(key, "stub-key-for-cli-it");
  const sql = postgres(inject("databaseUrl"), { max: 2 });
  try {
    // Idempotent — repeat runs against the same DB skip the seed.
    const existing = await sql<{ id: string }[]>`
      SELECT id FROM llm_providers WHERE name = 'cli-it-stub' LIMIT 1
    `;
    if (existing.length > 0) return;
    await sql.begin(async (tx) => {
      const [secret] = await tx<{ id: string }[]>`
        INSERT INTO secrets (id, name, ciphertext, nonce, description)
        VALUES (uuidv7(), 'cli_it_stub_key', ${toBase64(ciphertext)}, ${toBase64(nonce)}, 'cli-it stub')
        RETURNING id
      `;
      if (!secret) throw new Error("secret insert returned no row");
      const [provider] = await tx<{ id: string }[]>`
        INSERT INTO llm_providers (id, name, type, base_url, secret_id, attrs)
        VALUES (uuidv7(), 'cli-it-stub', 'anthropic', 'http://stub.invalid', ${secret.id}, '{}')
        RETURNING id
      `;
      if (!provider) throw new Error("provider insert returned no row");
      const [profile] = await tx<{ model: string }[]>`SELECT model FROM profiles LIMIT 1`;
      if (!profile) throw new Error("default profile not found");
      // Pick the next free position for this model so a peer integration
      // file that seeded its own provider at position 0 doesn't trip the
      // `uq_model_position` constraint. The CLI's skills handler only
      // needs *some* provider routed for the default model — which slot
      // it occupies doesn't matter.
      const [next] = await tx<{ pos: number }[]>`
        SELECT COALESCE(MAX(position) + 1, 0)::int AS pos
        FROM model_providers WHERE model = ${profile.model}
      `;
      const position = next?.pos ?? 0;
      await tx`
        INSERT INTO model_providers (id, model, provider_id, position, user_selectable)
        VALUES (uuidv7(), ${profile.model}, ${provider.id}, ${position}, true)
      `;
    });
  } finally {
    await sql.end();
  }
}

interface RunResult {
  code: number;
  stdout: string;
  stderr: string;
}

function runCli(
  args: readonly string[],
  extraEnv: Record<string, string> = {},
): Promise<RunResult> {
  return new Promise((resolve) => {
    const proc = spawn("node", ["--import", "tsx", "src/main.ts", "skills", ...args], {
      env: {
        ...process.env,
        DATABASE_URL: inject("databaseUrl"),
        HINDSIGHT_URL: inject("hindsightUrl"),
        INNGEST_BASE_URL: inject("inngestBaseUrl"),
        COGMO_MASTER_KEY: process.env.COGMO_MASTER_KEY,
        COGMO_SKILLS_PATH: process.env.COGMO_SKILLS_PATH,
        INNGEST_DEV: "true",
        LOG_LEVEL: "error",
        ...extraEnv,
      },
    });
    let stdout = "";
    let stderr = "";
    proc.stdout.on("data", (d) => {
      stdout += d.toString();
    });
    proc.stderr.on("data", (d) => {
      stderr += d.toString();
    });
    proc.on("close", (code) => resolve({ code: code ?? -1, stdout, stderr }));
  });
}

const ECHO_BODY = `
async def run(inputs, ctx):
    return {"echo": inputs["x"] + 1}
`;

const echoManifest = (name: string) => `---
name: ${name}
description: cli-integration echo skill
tier: wasm
inputs:
  type: object
  properties:
    x:
      type: integer
  required:
    - x
---
`;

/**
 * Seeds a skill by running a tiny inline TS program that bootstraps and calls
 * `__registerForTests`. Same code path as the production runner — proves the
 * end-to-end path before the CLI subprocess exercises it.
 */
async function seedSkill(name: string, manifestSource: string, body: string): Promise<void> {
  // Plain JS — `node -e` with --input-type=module rejects TS syntax.
  const seedScript = `
    import { bootstrap } from "./src/index.js";
    const { skillRunner } = await bootstrap();
    await skillRunner.__registerForTests({
      name: ${JSON.stringify(name)},
      manifestSource: ${JSON.stringify(manifestSource)},
      body: ${JSON.stringify(body)},
    });
    process.exit(0);
  `;
  await new Promise<void>((resolve, reject) => {
    const proc = spawn("node", ["--import", "tsx", "--input-type=module", "-e", seedScript], {
      env: {
        ...process.env,
        DATABASE_URL: inject("databaseUrl"),
        HINDSIGHT_URL: inject("hindsightUrl"),
        INNGEST_BASE_URL: inject("inngestBaseUrl"),
        COGMO_MASTER_KEY: process.env.COGMO_MASTER_KEY,
        COGMO_SKILLS_PATH: process.env.COGMO_SKILLS_PATH,
        INNGEST_DEV: "true",
        LOG_LEVEL: "error",
      },
    });
    let stderr = "";
    proc.stderr.on("data", (d) => {
      stderr += d.toString();
    });
    proc.on("close", (code) => {
      if (code === 0) resolve();
      else reject(new Error(`seed subprocess exited ${code}: ${stderr}`));
    });
  });
}

beforeAll(async () => {
  await seedStubProvider();
}, 60_000);

describe("cogmo skills CLI (integration)", { timeout: 60_000 }, () => {
  it("`skills` with no args prints usage and exits 0", async () => {
    const r = await runCli([]);
    expect(r.code).toBe(0);
    expect(r.stdout).toContain("Usage: cogmo skills");
  });

  it("`skills list` prints registered skills", async () => {
    const name = skillName("listed");
    await seedSkill(name, echoManifest(name), ECHO_BODY);
    const r = await runCli(["list"]);
    expect(r.code).toBe(0);
    expect(r.stdout).toContain("name\ttier\trisk\tdisabled\tgit_sha");
    expect(r.stdout).toContain(name);
  });

  it("`skills run` against a registered skill fails with 'no source' across processes", async () => {
    // P3.1 limitation: __registerForTests caches the skill body in-memory on
    // the seed-process runner. The CLI subprocess instantiates a fresh
    // runner that doesn't see that cache. P3.3 ships persistent storage
    // (git-show on the registered SHA) and the test will be replaced with
    // a real success-path round-trip. Until then, runner.integration covers
    // the success path within a single process.
    //
    // Today the runner throws (not returns Result), so the CLI exits with
    // code 1 and Node prints the unhandled rejection trace to stderr —
    // the `no source` message is asserted on stderr, not stdout.
    const name = skillName("runner");
    await seedSkill(name, echoManifest(name), ECHO_BODY);
    const r = await runCli(["run", name, '{"x":7}']);
    expect(r.code).not.toBe(0);
    expect(r.stderr).toMatch(/no source/);
  });

  it("`skills run` for a nonexistent skill exits non-zero", async () => {
    const r = await runCli(["run", "no-such-skill", "{}"]);
    expect(r.code).not.toBe(0);
  });

  it("`skills run` with malformed JSON inputs exits 2", async () => {
    const r = await runCli(["run", "anything", "{not json"]);
    expect(r.code).toBe(2);
    expect(r.stderr).toMatch(/invalid JSON/);
  });

  it("`skills nonsense` exits 1 with stderr usage message", async () => {
    const r = await runCli(["nonsense"]);
    expect(r.code).toBe(1);
    expect(r.stderr).toMatch(/Unknown skills command/);
  });
});
