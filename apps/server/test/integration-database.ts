import { randomBytes } from "node:crypto";
import postgres from "postgres";

/**
 * Every integration test file gets its own database, cloned from one migrated
 * template: `CREATE DATABASE … TEMPLATE` copies files instead of replaying
 * migrations, the approach of IntegreSQL and pgtestdb.
 *
 * The template is the container's `cogmo` database. Postgres refuses to clone
 * a database anything is connected to, so once migrated it stops accepting
 * connections: a stray connection fails at once instead of breaking every
 * clone after it.
 */
const TEMPLATE = "cogmo";

// App modules are imported inside the functions: the per-file setup must set
// `DATABASE_URL` before anything evaluates `src/env.ts`.

/**
 * Bot token for each file's seeded Telegram channel. BotFather's
 * `<bot_id>:<random>` shape, so grammY's URL builder produces a well-formed
 * path; every request goes to the integration setup's Telegram mock.
 */
const TELEGRAM_TEST_BOT_TOKEN = "1234567890:fake-test-token";

export function withDatabase(url: string, database: string): string {
  const u = new URL(url);
  u.pathname = `/${database}`;
  return u.toString();
}

export async function prepareTemplate(adminUrl: string): Promise<void> {
  const { drizzle } = await import("drizzle-orm/postgres-js");
  const { migratePerFile } = await import("../src/db/migrate-per-file.js");
  const { pinoNoticeHandler } = await import("../src/db/helpers.js");
  const schema = await import("../src/db/schemas.js");
  const client = postgres(withDatabase(adminUrl, TEMPLATE), { onnotice: pinoNoticeHandler });
  try {
    await migratePerFile(drizzle({ client, schema }), { migrationsFolder: "./migrations" });
  } finally {
    await client.end();
  }
  const admin = postgres(adminUrl);
  try {
    await admin`ALTER DATABASE ${admin(TEMPLATE)} WITH ALLOW_CONNECTIONS false`;
  } finally {
    await admin.end();
  }
}

/** Clone the template into a fresh database named after `label`; returns its URL. */
export async function cloneDatabase(adminUrl: string, label: string): Promise<string> {
  const slug = label
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "_")
    .slice(0, 40);
  const name = `it_${slug}_${randomBytes(4).toString("hex")}`;
  const admin = postgres(adminUrl);
  try {
    await admin`CREATE DATABASE ${admin(name)} TEMPLATE ${admin(TEMPLATE)}`;
  } finally {
    await admin.end();
  }
  return withDatabase(adminUrl, name);
}

/**
 * Seed a clone the way a deployment is seeded, plus a Telegram channel whose
 * `apiRoot` points at `telegramApiRoot`, so every `bootstrap()` starts a bot
 * against the mock. Returns the seeded user's id. Seeds `DATABASE_URL`, as the
 * `seed` command does.
 */
export async function seedDatabase(telegramApiRoot: string): Promise<string> {
  const databaseUrl = process.env.DATABASE_URL;
  if (databaseUrl === undefined) throw new Error("DATABASE_URL is unset");
  const { seed } = await import("../src/seed.js");
  await seed();

  const { drizzle } = await import("drizzle-orm/postgres-js");
  const schema = await import("../src/db/schemas.js");
  const { DrizzleAgentStore } = await import("../src/agent/store/index.js");
  const { channels } = await import("../src/transport/store/schema.js");
  const client = postgres(databaseUrl);
  try {
    const db = drizzle({ client, schema });
    await db.insert(channels).values({
      type: "telegram",
      credentials: { token: TELEGRAM_TEST_BOT_TOKEN, apiRoot: telegramApiRoot },
      identityMode: "create",
    });
    const user = await db.transaction((tx) => new DrizzleAgentStore().getFirstUser(tx));
    if (user === undefined) throw new Error("seed created no user");
    return user.id;
  } finally {
    await client.end();
  }
}
