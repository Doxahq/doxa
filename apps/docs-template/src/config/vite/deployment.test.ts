import { describe, expect, test } from "vitest";

import { getDevAllowedHosts, getLocalPlatformWorkerConfig } from "./deployment";

describe("development allowed hosts", () => {
  test("allows the docs domain and its preview subdomains", () => {
    expect(getDevAllowedHosts({ DOXA_DOCS_BASE_DOMAIN: "doxa.page" })).toEqual([
      "doxa.page",
      ".doxa.page",
    ]);
  });

  test.each(["localhost", "  ", undefined])(
    "adds nothing for a local run: %s",
    (docsBaseDomain) => {
      expect(
        getDevAllowedHosts({ DOXA_DOCS_BASE_DOMAIN: docsBaseDomain })
      ).toEqual([]);
    }
  );
});

describe("local platform Worker configuration", () => {
  test("is disabled outside the managed Doxa development stack", () => {
    expect(getLocalPlatformWorkerConfig({})).toBeUndefined();
  });

  test("configures platform content while keeping the token secret", () => {
    expect(
      getLocalPlatformWorkerConfig({
        DOXA_DOCS_LOCAL_PLATFORM_DEV: "1",
        DOXA_DOCS_CONTENT_WORKER_URL: "http://localhost:8788",
        DOXA_DOCS_CONTENT_TOKEN: "local-secret-token",
      })
    ).toEqual({
      vars: {
        DOXA_DOCS_RUNTIME_SOURCE: "platform",
        DOXA_DOCS_CONTENT_WORKER_URL: "http://localhost:8788",
        DOXA_DOCS_CONTENT_RUNTIME_PATH: "/runtime-source",
      },
      secrets: {
        required: ["DOXA_DOCS_CONTENT_TOKEN"],
      },
    });
  });

  test("carries local access-gate values into the dev Worker", () => {
    const config = getLocalPlatformWorkerConfig({
      DOXA_DOCS_LOCAL_PLATFORM_DEV: "1",
      DOXA_DOCS_CONTENT_WORKER_URL: "http://localhost:8788",
      DOXA_DOCS_CONTENT_TOKEN: "local-secret-token",
      DOXA_API_BASE_URL: "https://dev.doxa.so",
      DOXA_DASHBOARD_BASE_URL: "https://dev.doxa.so",
      DOXA_DOCS_BASE_DOMAIN: "localhost",
    });

    expect(config?.vars).toMatchObject({
      DOXA_API_BASE_URL: "https://dev.doxa.so",
      DOXA_DASHBOARD_BASE_URL: "https://dev.doxa.so",
      DOXA_DOCS_BASE_DOMAIN: "localhost",
    });
  });

  test("keeps the wrangler.json defaults when no override is set", () => {
    const config = getLocalPlatformWorkerConfig({
      DOXA_DOCS_LOCAL_PLATFORM_DEV: "1",
      DOXA_DOCS_CONTENT_WORKER_URL: "http://localhost:8788",
      DOXA_DOCS_CONTENT_TOKEN: "local-secret-token",
      DOXA_API_BASE_URL: "   ",
    });

    expect(config?.vars).not.toHaveProperty("DOXA_API_BASE_URL");
    expect(config?.vars).not.toHaveProperty("DOXA_DOCS_BASE_DOMAIN");
  });

  test("rejects non-http content worker URLs", () => {
    expect(() =>
      getLocalPlatformWorkerConfig({
        DOXA_DOCS_LOCAL_PLATFORM_DEV: "1",
        DOXA_DOCS_CONTENT_WORKER_URL: "file:///tmp/runtime-source",
        DOXA_DOCS_CONTENT_TOKEN: "local-secret-token",
      })
    ).toThrow("valid HTTP(S) origin");
  });
});
