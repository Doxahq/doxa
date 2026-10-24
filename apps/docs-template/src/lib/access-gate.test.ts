import { describe, expect, test, vi } from "vitest";

import { getAccessGateResponse } from "./access-gate";

const env = {
  DOXA_API_BASE_URL: "https://api.doxa.so",
  DOXA_DASHBOARD_BASE_URL: "https://doxa.so",
  DOXA_DOCS_BASE_DOMAIN: "doxa.page",
};

describe("getAccessGateResponse", () => {
  test("does no policy request for production documentation", async () => {
    const fetcher = vi.fn<typeof fetch>();

    await expect(
      getAccessGateResponse(new Request("https://demo.doxa.page/guide"), env, {
        fetcher,
        policyCache: null,
      })
    ).resolves.toBeNull();
    expect(fetcher).not.toHaveBeenCalled();
  });

  test("allows a public generation preview", async () => {
    const fetcher = vi
      .fn<typeof fetch>()
      .mockResolvedValue(Response.json({ policy: "public" }));

    await expect(
      getAccessGateResponse(createPreviewRequest(), env, {
        fetcher,
        policyCache: null,
      })
    ).resolves.toBeNull();
    expect(fetcher).toHaveBeenCalledTimes(1);
  });

  test("uses the cached policy without an API request", async () => {
    const fetcher = vi.fn<typeof fetch>();
    const policyCache = {
      match: vi.fn(async () => Response.json({ policy: "public" })),
      put: vi.fn(async () => undefined),
    };

    await expect(
      getAccessGateResponse(createPreviewRequest(), env, {
        fetcher,
        policyCache,
      })
    ).resolves.toBeNull();
    expect(fetcher).not.toHaveBeenCalled();
    expect(policyCache.match).toHaveBeenCalledTimes(1);
  });

  test("redirects an anonymous visitor to login", async () => {
    const fetcher = vi
      .fn<typeof fetch>()
      .mockResolvedValue(Response.json({ policy: "authenticated" }));

    const response = await getAccessGateResponse(createPreviewRequest(), env, {
      fetcher,
      policyCache: null,
    });

    expect(response?.status).toBe(302);
    expect(response?.headers.get("location")).toBe(
      "https://doxa.so/login?redirect=https%3A%2F%2Facme--a1b2c3d4e5f6.doxa.page%2Fguide"
    );
    expect(fetcher).toHaveBeenCalledTimes(1);
  });

  test("allows any signed-in Doxa user", async () => {
    const fetcher = vi
      .fn<typeof fetch>()
      .mockResolvedValueOnce(Response.json({ policy: "authenticated" }))
      .mockResolvedValueOnce(Response.json({ user: { id: "user-1" } }));

    await expect(
      getAccessGateResponse(
        createPreviewRequest({ cookie: "better-auth.session_token=token" }),
        env,
        { fetcher, policyCache: null }
      )
    ).resolves.toBeNull();
    expect(fetcher).toHaveBeenCalledTimes(2);
  });

  // Every failure below must gate the request. A preview is private by default,
  // so an unreadable policy, an unreadable body, or missing configuration must
  // never fall through to the renderer.
  test("gates the request when the policy request fails", async () => {
    const fetcher = vi
      .fn<typeof fetch>()
      .mockRejectedValueOnce(new Error("network unreachable"));

    const response = await getAccessGateResponse(createPreviewRequest(), env, {
      fetcher,
      policyCache: null,
    });

    expect(response?.status).toBe(302);
  });

  test("gates the request when the policy response is not JSON", async () => {
    const fetcher = vi
      .fn<typeof fetch>()
      .mockResolvedValueOnce(new Response("not json"));

    const response = await getAccessGateResponse(createPreviewRequest(), env, {
      fetcher,
      policyCache: null,
    });

    expect(response?.status).toBe(302);
  });

  test("gates the request when the API rejects the policy request", async () => {
    const fetcher = vi
      .fn<typeof fetch>()
      .mockResolvedValueOnce(new Response("nope", { status: 500 }));

    const response = await getAccessGateResponse(createPreviewRequest(), env, {
      fetcher,
      policyCache: null,
    });

    expect(response?.status).toBe(302);
  });

  test("gates a signed-in visitor when the session request fails", async () => {
    const fetcher = vi
      .fn<typeof fetch>()
      .mockResolvedValueOnce(Response.json({ policy: "authenticated" }))
      .mockRejectedValueOnce(new Error("network unreachable"));

    const response = await getAccessGateResponse(
      createPreviewRequest({ cookie: "better-auth.session_token=token" }),
      env,
      { fetcher, policyCache: null }
    );

    expect(response?.status).toBe(302);
  });

  test.each(["DOXA_API_BASE_URL", "DOXA_DASHBOARD_BASE_URL"])(
    "refuses to serve a preview when %s is missing",
    async (name) => {
      const fetcher = vi.fn<typeof fetch>();

      const response = await getAccessGateResponse(
        createPreviewRequest(),
        { ...env, [name]: undefined },
        { fetcher, policyCache: null }
      );

      expect(response?.status).toBe(503);
      expect(fetcher).not.toHaveBeenCalled();
    }
  );
});

function createPreviewRequest(headers?: HeadersInit): Request {
  return new Request("https://acme--a1b2c3d4e5f6.doxa.page/guide", {
    headers,
  });
}
