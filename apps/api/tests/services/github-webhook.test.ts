import { describe, expect, test } from "vitest";
import { verifyGitHubWebhook } from "../../src/services/github-webhook";

describe("verifyGitHubWebhook", () => {
  test("rejects webhooks when no secret is configured", async () => {
    const request = new Request("http://localhost/github/webhook");

    await expect(verifyGitHubWebhook(request, {}, "{}")).resolves.toBe(false);
  });

  test("allows an explicit development-only insecure bypass", async () => {
    const request = new Request("http://localhost/github/webhook");

    await expect(verifyGitHubWebhook(request, {
      ALLOW_INSECURE_GITHUB_WEBHOOKS: "true",
      DOXA_RUNTIME_ENVIRONMENT: "development",
    }, "{}")).resolves.toBe(true);
  });

  test("refuses the insecure bypass in production or an unspecified environment", async () => {
    const request = new Request("https://api.doxa.so/github/webhook");

    await expect(verifyGitHubWebhook(request, {
      ALLOW_INSECURE_GITHUB_WEBHOOKS: "true",
      DOXA_RUNTIME_ENVIRONMENT: "production",
    }, "{}")).resolves.toBe(false);
    await expect(verifyGitHubWebhook(request, {
      ALLOW_INSECURE_GITHUB_WEBHOOKS: "true",
    }, "{}")).resolves.toBe(false);
    await expect(verifyGitHubWebhook(request, {
      ALLOW_INSECURE_GITHUB_WEBHOOKS: "false",
      DOXA_RUNTIME_ENVIRONMENT: "development",
    }, "{}")).resolves.toBe(false);
  });

  test("rejects missing and malformed signatures when secret is configured", async () => {
    await expect(
      verifyGitHubWebhook(new Request("http://localhost/github/webhook"), {
        GITHUB_WEBHOOK_SECRET: "secret",
      }, "{}"),
    ).resolves.toBe(false);

    await expect(
      verifyGitHubWebhook(new Request("http://localhost/github/webhook", {
        headers: { "x-hub-signature-256": "sha1=bad" },
      }), { GITHUB_WEBHOOK_SECRET: "secret" }, "{}"),
    ).resolves.toBe(false);

    for (const signature of [
      "sha256=bad",
      `sha256=${"g".repeat(64)}`,
      `sha256=${"a".repeat(64)}-suffix`,
    ]) {
      await expect(
        verifyGitHubWebhook(new Request("http://localhost/github/webhook", {
          headers: { "x-hub-signature-256": signature },
        }), { GITHUB_WEBHOOK_SECRET: "secret" }, "{}"),
      ).resolves.toBe(false);
    }
  });

  test("accepts a valid sha256 HMAC and rejects a changed body", async () => {
    const body = "Hello, World!";
    const signature = "sha256=757107ea0eb2509fc211221cce984b8a37570b6d7586c22c46f4379c8b043e17";
    const request = new Request("http://localhost/github/webhook", {
      headers: { "x-hub-signature-256": signature },
    });

    await expect(
      verifyGitHubWebhook(request, {
        GITHUB_WEBHOOK_SECRET: "It's a Secret to Everybody",
      }, body),
    ).resolves.toBe(true);
    await expect(
      verifyGitHubWebhook(request, {
        GITHUB_WEBHOOK_SECRET: "It's a Secret to Everybody",
      }, "Hello, World?"),
    ).resolves.toBe(false);
  });
});
