import { describe, expect, test } from "vitest";
import { getTrustedOrigins } from "@doxahq/auth";

/** SECURITY REGRESSION GUARDRAIL (SEC-019): a deployed API never trusts localhost. */
describe("trusted origins", () => {
  test("a deployed API trusts only its own and the dashboard origin", () => {
    expect(
      getTrustedOrigins({ BETTER_AUTH_URL: "https://api.doxa.so", WEB_ORIGIN: "https://doxa.so" }),
    ).toEqual(["https://api.doxa.so", "https://doxa.so"]);
  });

  test("a local API also trusts the local dashboard", () => {
    expect(
      getTrustedOrigins({ BETTER_AUTH_URL: "http://localhost:8787", WEB_ORIGIN: "http://localhost:3001" }),
    ).toEqual(["http://localhost:8787", "http://localhost:3001", "http://127.0.0.1:3001"]);
  });

  test("extra origins come only from BETTER_AUTH_TRUSTED_ORIGINS", () => {
    expect(
      getTrustedOrigins({
        BETTER_AUTH_URL: "https://dev.doxa.so",
        WEB_ORIGIN: "https://dev.doxa.so",
        BETTER_AUTH_TRUSTED_ORIGINS: "http://localhost:3001",
      }),
    ).toEqual(["https://dev.doxa.so", "http://localhost:3001"]);
  });
});
