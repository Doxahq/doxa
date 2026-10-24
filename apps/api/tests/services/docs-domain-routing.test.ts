import { afterEach, describe, expect, test, vi } from "vitest";
import { HttpDocsDomainRoutingProbe } from "../../src/services/docs-domain-routing";

describe("HttpDocsDomainRoutingProbe", () => {
  afterEach(() => {
    vi.useRealTimers();
    vi.unstubAllGlobals();
  });

  test("preserves the Cloudflare runtime receiver for the default fetcher", async () => {
    const receiverSensitiveFetch = function (
      this: typeof globalThis,
      ..._args: Parameters<typeof fetch>
    ): ReturnType<typeof fetch> {
      if (this !== globalThis) {
        throw new TypeError("Illegal invocation");
      }

      return Promise.resolve(
        new Response(null, {
          status: 204,
          headers: { "x-doxa-renderer-health": "ok" },
        }),
      );
    };
    vi.stubGlobal("fetch", receiverSensitiveFetch);
    const probe = new HttpDocsDomainRoutingProbe({
      now: () => new Date("2026-09-02T09:35:00.000Z"),
    });

    await expect(probe.check("docs.example.com")).resolves.toEqual({
      status: "healthy",
      httpStatus: 204,
      error: null,
      checkedAt: new Date("2026-09-02T09:35:00.000Z"),
    });
  });

  test("marks the docs renderer health response as healthy", async () => {
    const fetcher = vi.fn<typeof fetch>().mockResolvedValue(
      new Response(null, {
        status: 204,
        headers: { "x-doxa-renderer-health": "ok" },
      }),
    );
    const probe = new HttpDocsDomainRoutingProbe({
      fetcher,
      now: () => new Date("2026-08-31T10:00:00.000Z"),
    });

    await expect(probe.check("docs.example.com")).resolves.toEqual({
      status: "healthy",
      httpStatus: 204,
      error: null,
      checkedAt: new Date("2026-08-31T10:00:00.000Z"),
    });
    expect(fetcher).toHaveBeenCalledWith(
      "https://docs.example.com/.well-known/doxa-health",
      expect.objectContaining({
        method: "HEAD",
        redirect: "manual",
      }),
    );
  });

  test("rejects a response that did not come from the docs renderer health endpoint", async () => {
    const probe = new HttpDocsDomainRoutingProbe({
      fetcher: vi
        .fn<typeof fetch>()
        .mockResolvedValue(new Response(null, { status: 200 })),
      now: () => new Date("2026-08-31T10:00:00.000Z"),
    });

    await expect(probe.check("docs.example.com")).resolves.toEqual({
      status: "failed",
      httpStatus: 200,
      error:
        "The hostname responded without the Doxa documentation renderer health response.",
      checkedAt: new Date("2026-08-31T10:00:00.000Z"),
    });
  });

  test("logs safe network error details and returns a user-safe error", async () => {
    const warnings: Array<{
      hostname: string;
      errorName: string;
      errorMessage: string;
    }> = [];
    const probe = new HttpDocsDomainRoutingProbe({
      fetcher: vi
        .fn<typeof fetch>()
        .mockRejectedValue(new TypeError("fetch failed")),
      now: () => new Date("2026-08-31T10:00:00.000Z"),
      onRequestError: (warning) => warnings.push(warning),
    });

    await expect(probe.check("docs.example.com")).resolves.toEqual({
      status: "failed",
      httpStatus: null,
      error: "The routing check could not reach the documentation renderer.",
      checkedAt: new Date("2026-08-31T10:00:00.000Z"),
    });
    expect(warnings).toEqual([
      {
        hostname: "docs.example.com",
        errorName: "TypeError",
        errorMessage: "fetch failed",
      },
    ]);
  });

  test("reports Cloudflare origin errors as failed routing", async () => {
    const probe = new HttpDocsDomainRoutingProbe({
      fetcher: vi
        .fn<typeof fetch>()
        .mockResolvedValue(new Response(null, { status: 522 })),
      now: () => new Date("2026-08-31T10:00:00.000Z"),
    });

    await expect(probe.check("docs.example.com")).resolves.toEqual({
      status: "failed",
      httpStatus: 522,
      error:
        "Cloudflare reached the custom hostname, but the documentation origin returned HTTP 522.",
      checkedAt: new Date("2026-08-31T10:00:00.000Z"),
    });
  });

  test("keeps the default routing deadline inside the request budget", async () => {
    vi.useFakeTimers();
    const fetcher = vi.fn<typeof fetch>(
      (_input, init) =>
        new Promise((_resolve, reject) => {
          init?.signal?.addEventListener("abort", () => {
            reject(
              new DOMException("The operation was aborted.", "AbortError"),
            );
          });
        }),
    );
    const probe = new HttpDocsDomainRoutingProbe({
      fetcher,
      now: () => new Date("2026-08-31T10:00:00.000Z"),
    });
    const result = probe.check("docs.example.com");

    await vi.advanceTimersByTimeAsync(5_000);

    await expect(result).resolves.toMatchObject({
      status: "failed",
      error:
        "The routing check timed out before the documentation renderer responded.",
    });
  });

  test("stops a routing check that exceeds its deadline", async () => {
    vi.useFakeTimers();
    const fetcher = vi.fn<typeof fetch>(
      (_input, init) =>
        new Promise((_resolve, reject) => {
          init?.signal?.addEventListener("abort", () => {
            reject(
              new DOMException("The operation was aborted.", "AbortError"),
            );
          });
        }),
    );
    const probe = new HttpDocsDomainRoutingProbe({
      fetcher,
      timeoutMs: 1_000,
      now: () => new Date("2026-08-31T10:00:00.000Z"),
    });
    const result = probe.check("docs.example.com");

    await vi.advanceTimersByTimeAsync(1_000);

    await expect(result).resolves.toEqual({
      status: "failed",
      httpStatus: null,
      error:
        "The routing check timed out before the documentation renderer responded.",
      checkedAt: new Date("2026-08-31T10:00:00.000Z"),
    });
  });
});
