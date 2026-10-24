import { describe, expect, test } from "vitest";
import { REDACTED, SecretRedactor } from "../../src/reference-specs/secrets";

describe("secret redaction", () => {
  test.each([
    ["a Stripe live key", "sk_live_51HxAbCdEfGhIjKlMnOp"],
    ["a GitHub token", `ghp_${"a".repeat(36)}`],
    ["a GitHub fine-grained token", `github_pat_${"A1".repeat(20)}`],
    ["an AWS access key ID", "AKIAABCDEFGHIJKLMNOP"],
    ["a Slack token", "xoxb-1234567890-abcdefghij"],
    ["a JWT", "eyJhbGciOiJIUzI1NiJ9.eyJzdWIiOiIxMjM0NTY3ODkwIn0.dozjgNryP4J3jVmNHl0w5N_XgL0n3I9PlFUP0THsR8U"],
    ["a private key", "-----BEGIN RSA PRIVATE KEY-----\nMIIEow\n-----END RSA PRIVATE KEY-----"],
  ])("removes %s", (_label, secret) => {
    expect(new SecretRedactor().redact(`value: ${secret}`)).toBe(`value: ${REDACTED}`);
  });

  test("keeps test keys and ordinary text", () => {
    expect(new SecretRedactor().redact("sk_test_123 and order ord_123")).toBe("sk_test_123 and order ord_123");
  });

  test("always redacts the example of a credential parameter", () => {
    const redactor = new SecretRedactor();

    expect(redactor.redactExample("Bearer abc", "Authorization", new Set())).toBe(REDACTED);
    expect(redactor.redactExample("key-123", "X-API-Key", new Set(["x-api-key"]))).toBe(REDACTED);
    expect(redactor.redactExample("42", "limit", new Set(["x-api-key"]))).toBe("42");
    expect(redactor.count).toBe(2);
  });
});
