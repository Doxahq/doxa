import { describe, expect, test } from "vitest";
import { resolveRestApiRuntimeFeatures } from "@doxahq/agent";
import { createRuntimeDocsArtifacts } from "@doxahq/docs-engine";

describe("generated runtime features", () => {
  test("writes a disabled API playground when analysis rejects browser requests", async () => {
    const features = resolveRestApiRuntimeFeatures({
      referenceSurfaces: {
        rest: {
          sourceEvidence: [],
          playground: { enabled: false, reason: "CORS is not enabled." },
          groups: [{
            id: "health",
            title: "Health",
            sourceEvidence: [],
            endpoints: [{
              id: "get-health",
              title: "Get health",
              method: "GET",
              path: "/health",
              description: "Read the public service health state.",
              sourceEvidence: [],
            }],
          }],
        },
      },
    });
    const bundle = await createRuntimeDocsArtifacts({
      siteId: "site-1",
      versionId: "version-1",
      projectSlug: "demo",
      projectName: "Demo",
      pages: [],
      features,
    });
    const artifact = bundle.files.find(
      (file) => file.path === "settings/site.json",
    );

    expect(artifact).toBeDefined();
    expect(JSON.parse(artifact?.content ?? "null")).toMatchObject({
      features: { apiPlayground: false },
    });
  });
});
