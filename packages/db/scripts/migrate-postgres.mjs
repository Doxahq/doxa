import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { drizzle } from "drizzle-orm/node-postgres";
import { migrate } from "drizzle-orm/node-postgres/migrator";
import pg from "pg";

const { Pool } = pg;

const databaseUrl = process.env.DATABASE_URL;
const databaseSsl = process.env.DATABASE_SSL;
const migrationsSchema = process.env.DRIZZLE_MIGRATIONS_SCHEMA ?? "drizzle";
const migrationsTable =
  process.env.DRIZZLE_MIGRATIONS_TABLE ?? "__drizzle_migrations";

if (!databaseUrl) {
  console.error("DATABASE_URL is required.");
  process.exit(1);
}

function sslConfig() {
  if (!databaseSsl || databaseSsl === "false" || databaseSsl === "disable") {
    return undefined;
  }

  if (
    databaseSsl === "true" ||
    databaseSsl === "require" ||
    databaseSsl === "verify-full"
  ) {
    return { rejectUnauthorized: true };
  }

  if (databaseSsl === "allow" || databaseSsl === "prefer") {
    return { rejectUnauthorized: false };
  }

  throw new Error(
    "DATABASE_SSL must be one of: true, false, require, verify-full, allow, prefer, disable.",
  );
}

function redactedUrl(value) {
  try {
    const url = new URL(value);
    if (url.password) {
      url.password = "REDACTED";
    }
    return url.toString();
  } catch {
    return "<invalid DATABASE_URL>";
  }
}

const currentDir = dirname(fileURLToPath(import.meta.url));
const migrationsFolder = resolve(currentDir, "../migrations");
const pool = new Pool({
  connectionString: databaseUrl,
  ssl: sslConfig(),
  max: 1,
});

try {
  console.log(`Running migrations against: ${redactedUrl(databaseUrl)}`);
  console.log(`DATABASE_SSL=${databaseSsl ?? "<not set>"}`);
  console.log(`Migrations folder: ${migrationsFolder}`);
  console.log(`Migrations table: ${migrationsSchema}.${migrationsTable}`);

  const client = await pool.connect();
  client.release();

  const db = drizzle(pool);
  await migrate(db, {
    migrationsFolder,
    migrationsSchema,
    migrationsTable,
  });

  console.log("Migrations applied successfully.");
} catch (error) {
  console.error("Migration failed.");
  console.error(error);
  process.exitCode = 1;
} finally {
  await pool.end().catch(() => {});
}
