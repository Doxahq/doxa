import { describe, expect, test, vi } from "vitest";

import {
  loadProductionRouteData,
  startVersionMismatchNavigation,
} from "./production-route-data";

const capability = {
  mode: "public-production" as const,
  renderId: "a".repeat(64),
  schemaVersion: 1 as const,
};

describe("production route-data adapter", () => {
  test("loads and validates saved route data with omitted credentials", async () => {
    const fetcher = vi.fn(async () =>
      Response.json({
        status: "ok",
        schemaVersion: 1,
        renderId: capability.renderId,
        data: { type: "redirect", href: "/guide", status: 308 },
      })
    );

    await expect(
      loadProductionRouteData({
        pathname: "/guide",
        capability,
        fetcher,
        liveFallback: vi.fn(),
      })
    ).resolves.toEqual({ type: "redirect", href: "/guide", status: 308 });
    expect(fetcher).toHaveBeenCalledWith(
      `/_doxa/route-data/v1?path=%2Fguide&render=${capability.renderId}`,
      expect.objectContaining({ credentials: "omit" })
    );
  });

  test("uses the original live server function once for temporary unavailability", async () => {
    const liveFallback = vi.fn(async () => ({
      status: "ok" as const,
      schemaVersion: 1 as const,
      renderId: capability.renderId,
      data: { type: "empty" as const, homeHref: null },
    }));

    await expect(
      loadProductionRouteData({
        pathname: "/",
        capability,
        fetcher: vi.fn(
          async () => new Response("unavailable", { status: 503 })
        ),
        liveFallback,
      })
    ).resolves.toEqual({ type: "empty", homeHref: null });
    expect(liveFallback).toHaveBeenCalledOnce();
    expect(liveFallback).toHaveBeenCalledWith("/", capability.renderId);
  });

  test("rejects HTML and mismatched render identities", async () => {
    await expect(
      loadProductionRouteData({
        pathname: "/guide",
        capability,
        fetcher: vi.fn(
          async () => new Response("<html>login</html>", { status: 200 })
        ),
        liveFallback: vi.fn(),
      })
    ).rejects.toThrow(/content type/i);

    await expect(
      loadProductionRouteData({
        pathname: "/guide",
        capability,
        fetcher: vi.fn(async () =>
          Response.json({
            status: "ok",
            schemaVersion: 1,
            renderId: "b".repeat(64),
            data: { type: "empty", homeHref: null },
          })
        ),
        liveFallback: vi.fn(),
      })
    ).rejects.toThrow(/version/i);
  });

  test("rejects an oversized JSON response before parsing it", async () => {
    await expect(
      loadProductionRouteData({
        pathname: "/guide",
        capability,
        fetcher: vi.fn(
          async () =>
            new Response("{}", {
              status: 200,
              headers: {
                "content-type": "application/json",
                "content-length": String(2 * 1024 * 1024 + 1),
              },
            }),
        ),
        liveFallback: vi.fn(),
      }),
    ).rejects.toThrow(/size limit/i);
  });

  test("does not start a fallback after browser cancellation", async () => {
    const liveFallback = vi.fn();
    const abort = new DOMException("cancelled", "AbortError");

    await expect(
      loadProductionRouteData({
        pathname: "/guide",
        capability,
        fetcher: vi.fn(async () => {
          throw abort;
        }),
        liveFallback,
      })
    ).rejects.toBe(abort);
    expect(liveFallback).not.toHaveBeenCalled();
  });

  test("performs one same-origin document navigation and never reloads a preload", () => {
    let marker: string | null = null;
    const assign = vi.fn();
    const browser = {
      currentHref: "https://docs.example.com/guide",
      getMarker: () => marker,
      setMarker: (value: string) => {
        marker = value;
      },
      assign,
      now: () => 1_000,
    };

    expect(
      startVersionMismatchNavigation(
        { destinationHref: "/api?tab=one#example", preload: true },
        browser
      )
    ).toBe(false);
    expect(assign).not.toHaveBeenCalled();

    expect(
      startVersionMismatchNavigation(
        { destinationHref: "/api?tab=one#example", preload: false },
        browser
      )
    ).toBe(true);
    expect(assign).toHaveBeenCalledWith(
      "https://docs.example.com/api?tab=one#example"
    );

    expect(
      startVersionMismatchNavigation(
        { destinationHref: "/api?tab=one#example", preload: false },
        browser
      )
    ).toBe(false);
    expect(assign).toHaveBeenCalledOnce();
  });

  test("does not navigate to a cross-origin mismatch destination", () => {
    const assign = vi.fn();

    expect(
      startVersionMismatchNavigation(
        { destinationHref: "https://evil.example/path", preload: false },
        {
          currentHref: "https://docs.example.com/guide",
          getMarker: () => null,
          setMarker: vi.fn(),
          assign,
          now: () => 1_000,
        }
      )
    ).toBe(false);
    expect(assign).not.toHaveBeenCalled();
  });
});
