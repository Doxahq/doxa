import pg from "pg";

const { Client } = pg;

const databaseUrl = process.env.DATABASE_URL;
const databaseSsl = process.env.DATABASE_SSL;

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

const client = new Client({
  connectionString: databaseUrl,
  ssl: sslConfig(),
});

try {
  console.log(`Checking PostgreSQL connection: ${redactedUrl(databaseUrl)}`);
  console.log(`DATABASE_SSL=${databaseSsl ?? "<not set>"}`);

  await client.connect();
  const result = await client.query(
    "select current_database() as database, current_user as user, version() as version",
  );

  console.log("Connection OK.");
  console.log(JSON.stringify(result.rows[0], null, 2));
} catch (error) {
  console.error("Connection failed.");
  console.error(error);
  process.exitCode = 1;
} finally {
  await client.end().catch(() => {});
}
