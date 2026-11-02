import { describe, expect, test, vi } from "vitest";
import { limitDocsRequest } from "../src/request-limit";

/** SECURITY REGRESSION GUARDRAIL (SEC-007): one client cannot make unbounded uncached renders. */
describe("limitDocsRequest", () => {
  function request(ip: string | null) {
    return new Request("https://acme.doxa.page/guide?x=1", {
      headers: ip ? { "cf-connecting-ip": ip } : {},
    });
  }

  test("answers 429 when the client IP is over the limit", async () => {
    const limiter = { limit: vi.fn(async () => ({ success: false })) };

    const response = await limitDocsRequest(request("203.0.113.9"), {
      DOCS_REQUEST_LIMITER: limiter as never,
    });

    expect(response?.status).toBe(429);
    expect(response?.headers.get("retry-after")).toBe("60");
    expect(response?.headers.get("cache-control")).toBe("private, no-store");
    expect(limiter.limit).toHaveBeenCalledWith({ key: "203.0.113.9" });
  });

  test("lets a client under the limit through", async () => {
    const limiter = { limit: vi.fn(async () => ({ success: true })) };

    await expect(
      limitDocsRequest(request("203.0.113.9"), { DOCS_REQUEST_LIMITER: limiter as never }),
    ).resolves.toBeNull();
  });

  test("does not limit requests without a client IP or without the binding", async () => {
    const limiter = { limit: vi.fn(async () => ({ success: false })) };

    await expect(
      limitDocsRequest(request(null), { DOCS_REQUEST_LIMITER: limiter as never }),
    ).resolves.toBeNull();
    await expect(limitDocsRequest(request("203.0.113.9"), {})).resolves.toBeNull();
    expect(limiter.limit).not.toHaveBeenCalled();
  });
});
