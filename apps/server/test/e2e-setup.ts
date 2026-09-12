import { spawn } from "node:child_process";
import type { LLMock } from "@copilotkit/aimock";
import type { StartedTestContainer } from "testcontainers";
import { GenericContainer, Network, Wait } from "testcontainers";
import type { GlobalSetupContext } from "vitest/node";
import * as c from "../dev/containers.js";
import { repoRoot } from "../src/test/repo-root.js";
import { createMock } from "./llmock-setup.js";
import { loadRootEnv } from "./load-root-env.js";

loadRootEnv();

/// <reference path="./vitest.d.ts" />

const containers: StartedTestContainer[] = [];
let network: Awaited<ReturnType<InstanceType<typeof Network>["start"]>> | null = null;
let mock: LLMock | null = null;

/**
 * Tag the local build produces, mirrored from the `cogmo-e2e` bake target.
 * Also the image name `skills.e2e.test.ts` filters containers by.
 */
const E2E_IMAGE_FALLBACK = "cogmo-e2e";

/** Ceiling on the local image build. See `bakeAppImage`. */
const BAKE_TIMEOUT_MS = 20 * 60_000;

/** How long a timed-out bake gets to exit on SIGTERM before SIGKILL. */
const BAKE_KILL_GRACE_MS = 10_000;

/**
 * Build the app image through the same bake file CI uses, so both tiers build
 * from one definition of what goes into it. `--load` imports the result into
 * the daemon, which is where `GenericContainer` then looks for it.
 *
 * Bake rather than `GenericContainer.fromDockerfile`: testcontainers builds
 * its tar client-side, and to honour a `.dockerignore` whose allowlist
 * re-includes nested paths — which the repo's is — it has to enumerate every
 * file under the context before filtering, `node_modules` and `.git`
 * included. BuildKit does that walk itself, with the ignore rules applied as
 * it goes.
 *
 * stdio is inherited so a cold build (several minutes) shows progress rather
 * than hanging silently behind `globalSetup`.
 */
async function bakeAppImage(): Promise<void> {
  console.log("Baking app image (target cogmo-e2e)...");
  await new Promise<void>((resolve, reject) => {
    const bake = spawn(
      "docker",
      ["buildx", "bake", "--file", "docker-bake.hcl", "--load", "cogmo-e2e"],
      { cwd: repoRoot(), stdio: "inherit" },
    );

    let timedOut = false;
    let escalation: NodeJS.Timeout | undefined;

    // Nothing else bounds this: `globalSetup` has no timeout of its own, and a
    // BuildKit stall or a registry that accepts the connection and then goes
    // quiet leaves the child alive with no output. Without a deadline that is
    // an indefinitely hung `pnpm test:e2e`. Generous enough for a cold build of
    // every stage on a slow link; the point is to fail loudly, not to be tight.
    const deadline = setTimeout(() => {
      timedOut = true;
      bake.kill("SIGTERM");
      // Rejecting here would hand the run back while the child is still alive,
      // and the stall this deadline exists for is exactly when a docker CLI is
      // slow to honour a signal — the process would outlive the test run
      // holding a build slot. Wait for `close` instead, escalating if the
      // grace period passes, so the rejection means the child is gone.
      escalation = setTimeout(() => bake.kill("SIGKILL"), BAKE_KILL_GRACE_MS);
    }, BAKE_TIMEOUT_MS);

    const settle = (finish: () => void) => {
      clearTimeout(deadline);
      clearTimeout(escalation);
      finish();
    };

    bake.on("error", (err) =>
      settle(() =>
        reject(
          new Error(
            `could not run \`docker buildx bake\` — is the docker CLI on PATH? (${err.message})`,
          ),
        ),
      ),
    );
    bake.on("close", (code, signal) =>
      settle(() => {
        if (timedOut) {
          reject(new Error(`\`docker buildx bake cogmo-e2e\` exceeded ${BAKE_TIMEOUT_MS}ms`));
        } else if (code === 0) {
          resolve();
        } else {
          reject(
            new Error(`\`docker buildx bake cogmo-e2e\` failed (code ${code}, signal ${signal})`),
          );
        }
      }),
    );
  });
}

export async function setup({ provide }: GlobalSetupContext) {
  network = await new Network().start();

  mock = createMock();
  await mock.start();
  // Must precede every container below — see `exposeHostPort`.
  const llmockBase = await c.exposeHostPort(mock.port);
  console.log(`llmock at ${mock.url}, reachable from containers at ${llmockBase}`);

  console.log("Starting containers...");
  const [pg, _rd, inn, mn] = await Promise.all([
    c.postgres(network).start(),
    c.redis(network).start(),
    c.inngest(network).start(),
    c.minio(network).start(),
  ]);
  containers.push(pg, _rd, inn, mn);

  // Slim Hindsight
  const llmockUrl = `${llmockBase}/v1`;
  const hindsightContainer = await c
    .hindsightSlim(network, {
      llmBaseUrl: llmockUrl,
      llmApiKey: process.env.OPENAI_API_KEY ?? "test-key",
      llmModel: "gpt-4o-mini",
      embeddingsBaseUrl: llmockUrl,
      embeddingsApiKey: process.env.OPENAI_API_KEY ?? "test-key",
      embeddingsModel: "text-embedding-3-small",
    })
    .start();
  containers.push(hindsightContainer);

  const { hindsightUrl, s3Endpoint, ...urls } = c.getUrls({
    postgres: pg,
    inngest: inn,
    hindsight: hindsightContainer,
    minio: mn,
  });
  if (!hindsightUrl) throw new Error("hindsight is required for e2e");
  if (!s3Endpoint) throw new Error("minio is required for e2e");

  await c.ensureFilesBucket(s3Endpoint);

  // CI bakes the image and passes the tag; a local run bakes it here.
  // `E2E_IMAGE_FALLBACK` mirrors the `cogmo-e2e` bake target's tag —
  // version-pins.test.ts holds the two together.
  const imageName = process.env.E2E_IMAGE ?? E2E_IMAGE_FALLBACK;
  if (process.env.E2E_IMAGE === undefined) {
    await bakeAppImage();
  } else {
    console.log(`Using pre-built image: ${imageName}`);
  }
  const appImage = new GenericContainer(imageName);

  // Same DB URL is used by both the seed container and the long-running app container,
  // both reaching Postgres via the testcontainers network alias.
  const inNetworkDatabaseUrl = "postgresql://cogmo@postgres:5432/cogmo";

  console.log("Running seed...");
  const seedContainer = await appImage
    .withNetwork(network)
    .withCommand(["seed"])
    .withEnvironment({ DATABASE_URL: inNetworkDatabaseUrl })
    .withWaitStrategy(Wait.forLogMessage(/seed complete/i))
    .withStartupTimeout(60_000)
    .start();
  await seedContainer.stop();
  console.log("Seed complete.");

  // Seed an LLM provider into the DB so bootstrap() can resolve it.
  // Uses the same Drizzle handle the app does — schema-typed inserts
  // keep this aligned with column renames + JSONB schema validation,
  // and remove a class of foot-guns (postgres-js raw `${jsValue}`
  // against typed columns) flagged by the project's code-style rules.
  const { generateMasterKey, parseMasterKey, deriveMasterKey, encrypt, toBase64 } = await import(
    "../src/secrets/encryption.js"
  );
  const { drizzle } = await import("drizzle-orm/postgres-js");
  const dbSchema = await import("../src/db/schemas.js");
  const { users, profiles, llmProviders, modelProviders } = dbSchema;
  const { secrets } = await import("../src/secrets/store/schema.js");

  const masterKey = generateMasterKey();
  const encKey = deriveMasterKey(parseMasterKey(masterKey), "cogmo/secrets-at-rest/v1");
  const apiKey = process.env.ANTHROPIC_API_KEY ?? "test-key";
  const { ciphertext, nonce } = encrypt(encKey, apiKey);

  const postgres = (await import("postgres")).default;
  const sql = postgres(urls.databaseUrl);
  const db = drizzle({ client: sql, schema: dbSchema });

  const userRows = await db.select({ id: users.id }).from(users).limit(1);
  const defaultUserId = userRows[0]?.id;
  if (!defaultUserId) throw new Error("Default user not found after seed");

  // Insert encrypted secret + provider + model routing inside one transaction so a
  // partial e2e seed can't leave orphaned rows (project rule: all DB ops transactional).
  await db.transaction(async (tx) => {
    const [secret] = await tx
      .insert(secrets)
      .values({
        name: "anthropic_api_key",
        ciphertext: toBase64(ciphertext),
        nonce: toBase64(nonce),
        description: "E2e test key",
      })
      .returning({ id: secrets.id });
    if (!secret) throw new Error("Secret insert returned no row");

    const [provider] = await tx
      .insert(llmProviders)
      .values({
        name: "anthropic",
        type: "anthropic",
        baseUrl: llmockBase,
        secretId: secret.id,
        attrs: {},
      })
      .returning({ id: llmProviders.id });
    if (!provider) throw new Error("Provider insert returned no row");

    const profileRows = await tx.select({ model: profiles.model }).from(profiles).limit(1);
    if (!profileRows[0]) throw new Error("Default profile not found after seed");

    await tx.insert(modelProviders).values({
      model: profileRows[0].model,
      providerId: provider.id,
      position: 0,
      userSelectable: true,
    });
  });
  await sql.end();

  console.log("Starting app container (connect mode)...");
  const appContainer = await appImage
    .withNetwork(network)
    .withCommand(["serve"])
    .withEnvironment({
      DATABASE_URL: inNetworkDatabaseUrl,
      COGMO_MASTER_KEY: masterKey,
      INNGEST_BASE_URL: "http://inngest:8288",
      INNGEST_CONNECT_GATEWAY_URL: "ws://inngest:8289/v0/connect",
      HINDSIGHT_URL: "http://hindsight:8888",
      S3_ENDPOINT: "http://minio:9000",
      S3_ACCESS_KEY: "minioadmin",
      S3_SECRET_KEY: "minioadmin",
      S3_BUCKET: "cogmo-files",
      INNGEST_DEV: "true",
      DEBOUNCE_IDLE_SECONDS: "0",
      DEBOUNCE_MAXWAIT_SECONDS: "0",
      LOG_LEVEL: "info",
      // COGMO_SKILLS_PATH falls back to its production default
      // (/var/lib/cogmo/skills) — the Dockerfile pre-creates that dir with
      // `nonroot` ownership so bootstrap can `git init --bare` into it.
      // Override only if the e2e suite needs a different mount.
      // Surface transient container/network blips as hard failures
      // instead of letting withRetry mask them. See src/util/with-retry.ts.
      RETRY_DISABLED: "true",
    })
    .withWaitStrategy(Wait.forLogMessage(/inngest connected/i))
    .withStartupTimeout(60_000)
    .start();
  containers.push(appContainer);
  console.log("App container ready.");

  provide("databaseUrl", urls.databaseUrl);
  provide("inngestBaseUrl", urls.inngestBaseUrl);
  provide("inngestEventKey", "test");
  provide("hindsightUrl", hindsightUrl);
  provide("defaultUserId", defaultUserId);
  // Exposed so tests can `docker exec` against the bundled binary — used
  // by the LiteLLM-snapshot smoke check that proves the resolver can find
  // `data/litellm-models.json` after tsup bundling. There's no way to
  // pass the testcontainers handle itself through `provide` (not JSON),
  // so we hand back the raw ID and the test uses the host docker CLI.
  provide("appContainerId", appContainer.getId());

  console.log(`E2E environment ready — ${JSON.stringify({ ...urls, hindsightUrl })}`);
}

export async function teardown() {
  if (mock) await mock.stop();

  console.log("Stopping containers...");
  for (const container of containers.reverse()) {
    await container.stop();
  }
  if (network) await network.stop();
  console.log("Containers stopped.");
}
