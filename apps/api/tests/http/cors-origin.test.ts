import { describe, expect, test } from "vitest";
import { isAllowedCorsOrigin } from "../../src/http/middleware";

/** SECURITY REGRESSION GUARDRAIL (SEC-020): CORS with credentials fails closed. */
describe("isAllowedCorsOrigin", () => {
  test("allows only the dashboard origin", () => {
    expect(isAllowedCorsOrigin("https://doxa.so", "https://doxa.so")).toBe(true);
    expect(isAllowedCorsOrigin("https://doxa.so", "https://doxa.so/")).toBe(true);
    expect(isAllowedCorsOrigin("https://evil.example", "https://doxa.so")).toBe(false);
  });

  test("allows no origin when WEB_ORIGIN is not set", () => {
    expect(isAllowedCorsOrigin("https://evil.example", undefined)).toBe(false);
    expect(isAllowedCorsOrigin("https://evil.example", "")).toBe(false);
  });
});
