import {
  createArtifactIdentity,
  createPrerenderObjectKey,
  createRenderContextId,
  createRenderId,
  createRendererReleaseId,
} from "@doxahq/contracts/docs-prerender";
import { describe, expect, test } from "vitest";

describe("pre-render identity", () => {
  test("uses canonical schema-versioned input", async () => {
    const first = await createArtifactIdentity({
      schemaVersion: 1,
      siteId: "site-1",
      artifactPrefix: "sites/site-1/versions/source-1",
      sourceManifestPath: "sites/site-1/versions/source-1/manifest.json",
    });
    const second = await createArtifactIdentity({
      sourceManifestPath: "sites/site-1/versions/source-1/manifest.json",
      artifactPrefix: "sites/site-1/versions/source-1",
      siteId: "site-1",
      schemaVersion: 1,
    });

    expect(first).toBe(second);
    expect(first).toMatch(/^[a-f0-9]{64}$/);
  });

  test("isolates tenants, origins, and renderer releases", async () => {
    const artifactA = await artifact("site-a");
    const artifactB = await artifact("site-b");
    const releaseA = await release("server-a");
    const releaseB = await release("server-b");
    const contextA = await createRenderContextId({
      schemaVersion: 1,
      trustedRequestOrigin: "https://a.doxa.page",
      effectivePublicOutputConfiguration: {
        canonicalOrigin: "https://a.doxa.page",
      },
    });
    const contextB = await createRenderContextId({
      schemaVersion: 1,
      trustedRequestOrigin: "https://b.doxa.page",
      effectivePublicOutputConfiguration: {
        canonicalOrigin: "https://b.doxa.page",
      },
    });

    const ids = await Promise.all([
      render("site-a", artifactA, releaseA, contextA),
      render("site-b", artifactB, releaseA, contextA),
      render("site-a", artifactA, releaseB, contextA),
      render("site-a", artifactA, releaseA, contextB),
    ]);
    expect(new Set(ids).size).toBe(ids.length);
    expect(
      createPrerenderObjectKey("site-a", ids[0]!, "a".repeat(64), "html"),
    ).toBe(
      `render/v1/sites/site-a/renders/${ids[0]}/objects/${"a".repeat(64)}.html`,
    );
  });

  test("rejects unsafe storage identity input", async () => {
    await expect(
      createRenderContextId({
        schemaVersion: 1,
        trustedRequestOrigin: "http://docs.example.com",
        effectivePublicOutputConfiguration: {},
      }),
    ).rejects.toThrow(/origin/i);
    expect(() =>
      createPrerenderObjectKey(
        "../site",
        "a".repeat(64),
        "b".repeat(64),
        "json",
      ),
    ).toThrow();
  });
});

async function artifact(siteId: string): Promise<string> {
  return createArtifactIdentity({
    schemaVersion: 1,
    siteId,
    artifactPrefix: `sites/${siteId}/versions/source-1`,
    sourceManifestPath: `sites/${siteId}/versions/source-1/manifest.json`,
  });
}

async function release(serverPackageDigest: string): Promise<string> {
  return createRendererReleaseId({
    schemaVersion: 1,
    serverPackageDigest,
    clientAssetManifestDigest: "client-a",
    outputSchemaVersion: 1,
  });
}

function render(
  siteId: string,
  artifactIdentity: string,
  rendererReleaseId: string,
  renderContextId: string,
) {
  return createRenderId({
    schemaVersion: 1,
    siteId,
    artifactIdentity,
    rendererReleaseId,
    renderContextId,
  });
}
