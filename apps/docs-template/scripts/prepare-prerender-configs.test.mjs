import { describe, expect, test } from "vitest";

import {
  prepareGeneratedConfig,
  validateReleaseTopology,
} from "./prepare-prerender-configs.mjs";

const releaseId = "a".repeat(64);

describe("validateReleaseTopology", () => {
  test("accepts one release across the private pre-render topology", () => {
    expect(() => validateReleaseTopology(createTopology())).not.toThrow();
  });

  test("rejects a release mismatch", () => {
    const topology = createTopology();
    topology.apiConfig.env.production.vars.DOXA_RENDERER_RELEASE_ID =
      "b".repeat(64);

    expect(() => validateReleaseTopology(topology)).toThrow(
      "API does not use",
    );
  });

  test("rejects a public pre-render Worker", () => {
    const topology = createTopology();
    topology.prerendererConfig.workers_dev = true;

    expect(() => validateReleaseTopology(topology)).toThrow("public route");
  });
});

describe("prepareGeneratedConfig", () => {
  test("rebases the Worker entry point for a config written under dist", () => {
    const config = prepareGeneratedConfig(
      { main: "src/index.ts" },
      "/workspace/apps/api/wrangler.json",
      "/workspace/apps/api/dist/wrangler.production.json",
    );

    expect(config.main).toBe("../src/index.ts");
  });

  test("requires an explicit Worker entry point", () => {
    expect(() =>
      prepareGeneratedConfig(
        {},
        "/workspace/apps/api/wrangler.json",
        "/workspace/apps/api/dist/wrangler.production.json",
      ),
    ).toThrow("entry point is missing");
  });
});

function createTopology() {
  return {
    releaseId,
    apiConfig: {
      env: {
        production: {
          vars: { DOXA_RENDERER_RELEASE_ID: releaseId },
          services: [
            {
              binding: "PRERENDER_QUEUE",
              service: "doxa-docs-prerenderer-production",
              entrypoint: "PrerenderQueue",
            },
          ],
        },
      },
    },
    dispatcherConfig: {
      vars: { DOXA_RENDERER_RELEASE_ID: releaseId },
      services: [
        {
          binding: "PRERENDER_TASKS",
          service: "doxa-api-production",
          entrypoint: "PrerenderTaskApi",
        },
      ],
      r2_buckets: [
        {
          binding: "DOCS_RENDERED_BUCKET",
          bucket_name: "doxa-docs-rendered-html",
        },
      ],
    },
    prerendererConfig: {
      workers_dev: false,
      preview_urls: false,
      routes: [],
      vars: { DOXA_RENDERER_RELEASE_ID: releaseId },
      services: [
        {
          binding: "PRERENDER_RENDERER",
          service: "doxa-docs-renderer",
          entrypoint: "PrerenderRendererApi",
        },
        {
          binding: "PRERENDER_TASKS",
          service: "doxa-api-production",
          entrypoint: "PrerenderTaskApi",
        },
      ],
      r2_buckets: [
        {
          binding: "DOCS_RENDERED_BUCKET",
          bucket_name: "doxa-docs-rendered-html",
        },
      ],
      workflows: [
        {
          binding: "PRERENDER_WORKFLOW",
          class_name: "DocsPrerenderWorkflow",
          name: "doxa-docs-prerender-production",
        },
      ],
    },
  };
}
