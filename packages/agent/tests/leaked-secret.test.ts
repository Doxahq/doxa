import { describe, expect, test } from "vitest";
import { findSecret } from "../src/reference-specs/secrets";
import { checkContentQuality } from "../src/utils/page-validator";

// Fake values, built at runtime so secret scanners on the public repository do not flag the source.
const ANTHROPIC_KEY = `sk-ant-api03-${"a1B2".repeat(10)}`;
const PEM_FENCE = "-".repeat(5);
const PRIVATE_KEY = ["PRIVATE", "KEY"].join(" ");

function page(body: string): string {
  return `## Authenticate\n\nSend your key with each request.\n\n${body}\n\nThe API answers with JSON.\n`;
}

describe("leaked secret detector", () => {
  test("a real-looking key makes the page fail without repeating the key", () => {
    const quality = checkContentQuality(page(`\`\`\`bash\ncurl -H "x-api-key: ${ANTHROPIC_KEY}" https://api.example.com\n\`\`\``));
    const issue = quality.issues.find((candidate) => candidate.check === "leakedSecret");

    expect(issue).toMatchObject({ severity: "hard", location: { line: 5 } });
    expect(issue?.message).not.toContain(ANTHROPIC_KEY);
    expect(issue?.location?.snippet).toBe("sk-ant…");
    expect(quality.acceptable).toBe(false);
  });

  test("a placeholder passes", () => {
    const quality = checkContentQuality(page("```bash\ncurl -H \"x-api-key: YOUR_API_KEY\" https://api.example.com\n```"));

    expect(quality.issues.map((candidate) => candidate.check)).not.toContain("leakedSecret");
  });

  test.each([
    ["GitHub token", `ghp_${"x".repeat(36)}`],
    ["AWS key ID", `AKIA${"ABCDEFGHIJKLMNOP"}`],
    ["OpenRouter key", `sk-or-v1-${"0f".repeat(32)}`],
    ["Google API key", `AIza${"Q".repeat(35)}`],
    ["private key", `${PEM_FENCE}BEGIN RSA ${PRIVATE_KEY}${PEM_FENCE}\nMIIE\n${PEM_FENCE}END RSA ${PRIVATE_KEY}${PEM_FENCE}`],
  ])("finds a %s", (_name, secret) => {
    expect(findSecret(`value: ${secret}`)).toEqual({ index: 7, length: secret.length });
  });

  test("findSecret can run many times on the same patterns", () => {
    expect(findSecret(ANTHROPIC_KEY)).not.toBeNull();
    expect(findSecret(ANTHROPIC_KEY)).not.toBeNull();
    expect(findSecret("nothing here")).toBeNull();
  });
});

// SECURITY REGRESSION GUARDRAIL (SEC-027): credentials without a known key shape.
describe("credentials without a known prefix", () => {
  // Built at runtime, so secret scanners on the public repository do not flag the source.
  const RANDOM = ["q7Vx", "2LmP", "9sKd", "W4tZ", "e8Rn", "J3yH"].join("");

  test("finds a password in a connection URL", () => {
    const text = `DATABASE_URL=postgres://app:${RANDOM}@db.internal:5432/app`;
    expect(findSecret(text)).toEqual({ index: text.indexOf(RANDOM), length: RANDOM.length });
  });

  test("finds a password in a connection URL without a username", () => {
    const text = `REDIS_URL=redis://:${RANDOM}@cache.internal:6379/0`;
    expect(findSecret(text)).toEqual({ index: text.indexOf(RANDOM), length: RANDOM.length });
  });

  test("finds a random value assigned to a secret-like name", () => {
    const text = `CLIENT_SECRET="${RANDOM}"`;
    expect(findSecret(text)).toEqual({ index: text.indexOf(RANDOM), length: RANDOM.length });
  });

  test.each([
    "postgres://user:password@localhost:5432/app",
    "postgres://postgres:postgres@localhost/app",
    "redis://:<password>@cache:6379",
    "redis://:password@localhost:6379",
    "redis://:your_redis_password1@localhost:6379",
    "redis://:${REDIS_PASSWORD}@cache:6379",
    "http://:8080@localhost",
    "API_KEY=YOUR_API_KEY",
    'apiKey: "your-api-key-goes-here-1234"',
    "token: string",
    'secretKey: process.env.SECRET_KEY',
    "password: ${DB_PASSWORD}",
    "https://user:pass@example.com",
  ])("lets the placeholder %s pass", (text) => {
    expect(findSecret(text)).toBeNull();
  });
});
