import { defineConfig } from "drizzle-kit";

const databaseSsl = process.env.DATABASE_SSL;
const migrationsSchema = process.env.DRIZZLE_MIGRATIONS_SCHEMA ?? "drizzle";
const migrationsTable =
  process.env.DRIZZLE_MIGRATIONS_TABLE ?? "__drizzle_migrations";

export default defineConfig({
  schema: "./src/schema/index.ts",
  out: "./migrations",
  dialect: "postgresql",
  migrations: {
    schema: migrationsSchema,
    table: migrationsTable,
  },
  dbCredentials: {
    url: process.env.DATABASE_URL ?? "",
    ssl:
      databaseSsl === "require" ||
      databaseSsl === "allow" ||
      databaseSsl === "prefer" ||
      databaseSsl === "verify-full"
        ? databaseSsl
        : databaseSsl === "true"
          ? true
          : undefined,
  },
  strict: true,
  verbose: true,
});
