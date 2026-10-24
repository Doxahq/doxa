import { describe, expect, test } from "vitest";
import { enforceMutationCsrf } from "../../src/http/csrf";
import type { Env } from "../../src/env";

describe("enforceMutationCsrf", () => {
  test("allows safe methods without an origin", () => {
    const response = enforceMutationCsrf(
      new Request("https://api.doxa.so/projects"),
      createEnv(),
      "/projects",
    );

    expect(response).toBeNull();
  });

  test("allows mutations from the configured web origin", () => {
    const response = enforceMutationCsrf(
      createMutationRequest({ origin: "https://doxa.so" }),
      createEnv(),
      "/projects",
    );

    expect(response).toBeNull();
  });

  test("allows mutations from trusted origin patterns", () => {
    const response = enforceMutationCsrf(
      createMutationRequest({ origin: "https://preview.doxa.so" }),
      createEnv({ BETTER_AUTH_TRUSTED_ORIGINS: "https://*.doxa.so" }),
      "/projects",
    );

    expect(response).toBeNull();
  });

  test("rejects mutations without an origin", () => {
    const response = enforceMutationCsrf(
      new Request("https://api.doxa.so/projects", { method: "POST" }),
      createEnv(),
      "/projects",
    );

    expect(response?.status).toBe(403);
  });

  test("rejects cross-site fetch metadata before origin matching", () => {
    const response = enforceMutationCsrf(
      createMutationRequest({
        origin: "https://doxa.so",
        "sec-fetch-site": "cross-site",
      }),
      createEnv(),
      "/projects",
    );

    expect(response?.status).toBe(403);
  });

  test("exempts Better Auth, internal, and webhook routes", () => {
    const request = new Request("https://api.doxa.so/api/auth/sign-out", { method: "POST" });

    expect(enforceMutationCsrf(request, createEnv(), "/api/auth/sign-out")).toBeNull();
    expect(enforceMutationCsrf(request, createEnv(), "/internal/jobs/job-1/running")).toBeNull();
    expect(enforceMutationCsrf(request, createEnv(), "/github/webhook")).toBeNull();
  });
});

function createMutationRequest(headers: Record<string, string>): Request {
  return new Request("https://api.doxa.so/projects", {
    method: "POST",
    headers,
  });
}

function createEnv(overrides: Partial<Env> = {}): Env {
  return {
    BETTER_AUTH_URL: "https://api.doxa.so",
    BETTER_AUTH_SECRET: "secret",
    WEB_ORIGIN: "https://doxa.so",
    ...overrides,
  } as Env;
}
