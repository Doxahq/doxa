import { afterEach, describe, expect, test, vi } from "vitest";

import { createExpectedPrerenderIdentity } from "../src/prerender-policy";
import { logRendererReleaseRejected } from "../src/release-check";
import { rejectedBuild } from "../src/versioned-entrypoint-protocol";

const DEPLOYED = "a".repeat(64);
const PREVIOUS = "b".repeat(64);

afterEach(() => {
  vi.restoreAllMocks();
});

describe("rejectedBuild", () => {
  test("accepts the deployed build", () => {
    expect(
      rejectedBuild(
        { requested: DEPLOYED, deployed: DEPLOYED, previous: null },
        false,
      ),
    ).toBeNull();
  });

  test("rejects another build as a mismatch", () => {
    expect(
      rejectedBuild(
        { requested: PREVIOUS, deployed: DEPLOYED, previous: null },
        false,
      ),
    ).toBe("mismatch");
  });

  test("rejects every call while no build is deployed", () => {
    expect(
      rejectedBuild({ requested: DEPLOYED, deployed: null, previous: null }, false),
    ).toBe("unconfigured");
  });

  test("accepts the previous build only for a probe", () => {
    const check = { requested: PREVIOUS, deployed: DEPLOYED, previous: PREVIOUS };
    expect(rejectedBuild(check, true)).toBeNull();
    expect(rejectedBuild(check, false)).toBe("mismatch");
  });
});

describe("logRendererReleaseRejected", () => {
  test("writes one line with the reason, the site and both releases", async () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => undefined);
    const expected = await createExpectedPrerenderIdentity({
      siteId: "site-1",
      artifactPrefix: "sites/site-1/versions/v1",
      manifestPath: "sites/site-1/versions/v1/manifest.json",
      rendererReleaseId: PREVIOUS,
      trustedRequestOrigin: "https://docs.example.com",
    });

    logRendererReleaseRejected({
      entrypoint: "DocsPrerenderCache",
      expected,
      deployedReleaseId: ` ${DEPLOYED} `,
      reason: "mismatch",
    });

    expect(JSON.parse(String(warn.mock.calls[0]?.[0]))).toEqual({
      event: "docs_cache_release_rejected",
      entrypoint: "DocsPrerenderCache",
      reason: "release_mismatch",
      siteId: "site-1",
      requestedReleaseId: PREVIOUS,
      deployedReleaseId: DEPLOYED,
    });
  });
});
