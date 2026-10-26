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
