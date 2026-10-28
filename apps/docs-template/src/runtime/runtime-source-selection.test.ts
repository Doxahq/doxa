import { describe, expect, test, vi } from "vitest";

import type {
  BindingRuntimeResolution,
  DocsContentBinding,
} from "./binding-runtime-source";
import {
  createDispatcherRuntimeSource,
  getPlatformRuntimeSourceConfig,
  getRuntimeSourceMode,
  readRendererRequestScope,
} from "./runtime-source-selection";

function resolutionFor(siteId: string): BindingRuntimeResolution {
  return {
    siteId,
    projectId: `project-${siteId}`,
    projectSlug: siteId,
    publishedVersionId: `version-${siteId}`,
    artifactPrefix: `sites/${siteId}/versions/v1`,
    manifestPath: `sites/${siteId}/versions/v1/manifest.json`,
    accessPolicy: "public",
  };
}

function bindingFor(siteId: string) {
  const request = vi.fn<DocsContentBinding["request"]>(async () => ({
    ok: true,
    data: { name: siteId },
  }));
  return { binding: { request } satisfies DocsContentBinding, request };
}

describe("runtime source selection", () => {
  test("defaults to vite mode", () => {
    expect(getRuntimeSourceMode({})).toBe("vite");
  });

  test("accepts explicit platform mode", () => {
    expect(getRuntimeSourceMode({ DOXA_DOCS_RUNTIME_SOURCE: "platform" })).toBe(
      "platform"
    );
  });

  test("rejects unknown runtime source modes", () => {
    expect(() =>
      getRuntimeSourceMode({ DOXA_DOCS_RUNTIME_SOURCE: "github" })
    ).toThrow('Unknown DOXA_DOCS_RUNTIME_SOURCE: "github"');
  });

  test("reads platform config from canonical env vars", () => {
    expect(
      getPlatformRuntimeSourceConfig({
        DOXA_DOCS_CONTENT_WORKER_URL: "https://content.example.com",
        DOXA_DOCS_CONTENT_PROJECT_ID: "project_123",
        DOXA_DOCS_CONTENT_TOKEN: "secret-token",
        DOXA_DOCS_CONTENT_RUNTIME_PATH: "/v1/runtime",
      })
    ).toEqual({
      contentWorkerUrl: "https://content.example.com",
      projectId: "project_123",
      accessToken: "secret-token",
      runtimePath: "/v1/runtime",
      timingEnabled: false,
    });
  });

  test("enables platform timing from the runtime timing env flag", () => {
    expect(
      getPlatformRuntimeSourceConfig({
        DOXA_DOCS_CONTENT_WORKER_URL: "https://content.example.com",
        DOXA_DOCS_CONTENT_PROJECT_ID: "project_123",
        DOXA_DOCS_CONTENT_TOKEN: "secret-token",
        DOXA_DOCS_RUNTIME_TIMING: "true",
      })
    ).toMatchObject({
      timingEnabled: true,
    });
  });

  test("uses the request host when the env pins no hostname", () => {
    const env = {
      DOXA_DOCS_CONTENT_WORKER_URL: "https://content.example.com",
      DOXA_DOCS_CONTENT_TOKEN: "secret-token",
    };
    expect(
      getPlatformRuntimeSourceConfig(env, "flagforge.localhost:3002")
    ).toMatchObject({ hostname: "flagforge.localhost:3002" });
    expect(
      getPlatformRuntimeSourceConfig(
        { ...env, DOXA_DOCS_CONTENT_HOSTNAME: "docs.example.com" },
        "flagforge.localhost:3002"
      )
    ).toMatchObject({ hostname: "docs.example.com" });
  });

  test("reads platform host-scoped config from canonical env vars", () => {
    expect(
      getPlatformRuntimeSourceConfig({
        DOXA_DOCS_CONTENT_WORKER_URL: "https://content.example.com",
        DOXA_DOCS_CONTENT_HOSTNAME: "docs.example.com",
        DOXA_DOCS_CONTENT_TOKEN: "secret-token",
      })
    ).toMatchObject({
      contentWorkerUrl: "https://content.example.com",
      hostname: "docs.example.com",
      accessToken: "secret-token",
    });
  });

  test("supports platform env aliases", () => {
    expect(
      getPlatformRuntimeSourceConfig({
        DOXA_PLATFORM_CONTENT_URL: "https://content.example.com",
        DOXA_PLATFORM_HOSTNAME: "docs.example.com",
        DOXA_PLATFORM_CONTENT_TOKEN: "secret-token",
      })
    ).toMatchObject({
      contentWorkerUrl: "https://content.example.com",
      hostname: "docs.example.com",
      accessToken: "secret-token",
    });
  });

  test("supports legacy platform project id aliases", () => {
    expect(
      getPlatformRuntimeSourceConfig({
        DOXA_PLATFORM_CONTENT_URL: "https://content.example.com",
        DOXA_PLATFORM_PROJECT_ID: "project_123",
        DOXA_PLATFORM_CONTENT_TOKEN: "secret-token",
      })
    ).toMatchObject({
      contentWorkerUrl: "https://content.example.com",
      projectId: "project_123",
      accessToken: "secret-token",
    });
  });

  test("requires platform content worker configuration", () => {
    expect(() => getPlatformRuntimeSourceConfig({})).toThrow(
      "Missing required platform runtime env var"
    );
  });
});

describe("renderer request scope", () => {
  test("reads a content binding and a resolution from entrypoint props", () => {
    const { binding } = bindingFor("site-a");
    const resolution = resolutionFor("site-a");
    expect(
      readRendererRequestScope({ content: binding, resolution })
    ).toEqual({ content: binding, resolution });
  });

  test.each([
    undefined,
    null,
    "props",
    {},
    { content: {}, resolution: resolutionFor("site-a") },
    { content: bindingFor("site-a").binding },
    {
      content: bindingFor("site-a").binding,
      resolution: { ...resolutionFor("site-a"), siteId: "" },
    },
    {
      content: bindingFor("site-a").binding,
      resolution: { ...resolutionFor("site-a"), accessPolicy: "private" },
    },
  ])("treats any other props as no scope: %j", (props) => {
    expect(readRendererRequestScope(props)).toBeUndefined();
  });

  test("the request scope wins over the content pinned in env", async () => {
    const pinned = bindingFor("site-env");
    const scoped = bindingFor("site-request");
    const source = createDispatcherRuntimeSource(
      {
        DOXA_DOCS_RUNTIME_SOURCE: "binding",
        DOXA_DOCS_CONTENT_BINDING: pinned.binding,
        DOXA_DOCS_CONTENT_RESOLUTION: resolutionFor("site-env"),
      },
      {
        requestScope: {
          content: scoped.binding,
          resolution: resolutionFor("site-request"),
        },
      }
    );

    await source?.getSiteConfig();

    expect(pinned.request).not.toHaveBeenCalled();
    expect(scoped.request).toHaveBeenCalledWith(
      expect.objectContaining({ resolution: resolutionFor("site-request") })
    );
  });

  test("a shared isolate without a request scope fails closed", () => {
    expect(() =>
      createDispatcherRuntimeSource({ DOXA_DOCS_RUNTIME_SOURCE: "binding" })
    ).toThrow("Binding runtime mode requires a content binding.");
  });
});
