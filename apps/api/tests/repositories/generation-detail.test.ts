import { describe, expect, test } from "vitest";
import {
  didGenerationGoLive,
  isGenerationServingProduction,
  resolveAuthor,
  resolveDeployment,
  resolveDeploymentState,
  resolveRerunLinks,
  resolveSource,
  resolveSourceProvider,
} from "../../src/repositories/generation-detail";

describe("generation detail assembly", () => {
  test("treats a promoted clone as the production version for its source generation", () => {
    expect(
      isGenerationServingProduction({
        generationVersion: {
          id: "version-1",
          artifactPrefix: "sites/site-1/versions/version-1",
        },
        publishedVersion: {
          id: "version-2",
          baselineVersionId: "version-1",
          artifactPrefix: "sites/site-1/versions/version-1",
        },
      }),
    ).toBe(true);
  });

  test("treats the version that a run's review published as the run's production version", () => {
    const generationVersion = { id: "version-1", artifactPrefix: "sites/site-1/versions/version-1" };
    const publishedVersion = {
      id: "version-2",
      baselineVersionId: null,
      artifactPrefix: "sites/site-1/versions/version-2",
    };

    expect(
      isGenerationServingProduction({ generationVersion, publishedVersion, reviewedVersionId: "version-2" }),
    ).toBe(true);
    expect(
      isGenerationServingProduction({ generationVersion, publishedVersion, reviewedVersionId: "version-3" }),
    ).toBe(false);
  });

  test("uses the GitHub login for a manual generation author", () => {
    expect(
      resolveAuthor({
        trigger: "manual",
        user: {
          name: "The Octocat",
          githubLogin: "octocat",
          image: "https://avatars.githubusercontent.com/u/1?v=4",
        },
        sourceAuthor: null,
      }),
    ).toEqual({
      kind: "user",
      displayName: "octocat",
      githubLogin: "octocat",
      avatarUrl: "https://avatars.githubusercontent.com/u/1?v=4",
    });
  });

  test("uses the linked Doxa profile for a pull request author", () => {
    expect(
      resolveAuthor({
        trigger: "doxabot",
        user: {
          name: "The Octocat",
          githubLogin: "octocat",
          image: "https://doxa.example/avatar.png",
        },
        sourceAuthor: {
          externalId: "1",
          handle: "octocat-at-trigger-time",
          avatarUrl: "https://avatars.githubusercontent.com/u/1?v=4",
        },
      }),
    ).toEqual({
      kind: "user",
      displayName: "octocat",
      githubLogin: "octocat",
      avatarUrl: "https://doxa.example/avatar.png",
    });
  });

  test("uses the GitHub snapshot until the pull request author links Doxa", () => {
    expect(
      resolveAuthor({
        trigger: "doxabot",
        user: null,
        sourceAuthor: {
          externalId: "1",
          handle: "octocat",
          avatarUrl: "https://avatars.githubusercontent.com/u/1?v=4",
        },
      }),
    ).toEqual({
      kind: "user",
      displayName: "octocat",
      githubLogin: "octocat",
      avatarUrl: "https://avatars.githubusercontent.com/u/1?v=4",
    });
  });

  test("keeps the automation fallback for legacy Doxabot generations", () => {
    expect(
      resolveAuthor({
        trigger: "doxabot",
        user: null,
        sourceAuthor: null,
      }),
    ).toEqual({
      kind: "automation",
      displayName: "Doxabot",
      githubLogin: null,
      avatarUrl: null,
    });
  });

  test("builds production source links and leaves the commit message empty", () => {
    expect(
      resolveSource({
        provider: "github",
        repositoryFullName: "doxa/demo",
        defaultBranch: "main",
        publicationMode: "production",
        targetRevision: "1234567890abcdef1234567890abcdef12345678",
        changeProposal: null,
      }),
    ).toEqual({
      provider: "github",
      repositoryFullName: "doxa/demo",
      repositoryUrl: "https://github.com/doxa/demo",
      branch: "main",
      branchUrl: "https://github.com/doxa/demo/tree/main",
      commit: {
        revision: "1234567890abcdef1234567890abcdef12345678",
        shortRevision: "1234567",
        url: "https://github.com/doxa/demo/commit/1234567890abcdef1234567890abcdef12345678",
        message: null,
      },
      changeProposal: null,
    });
  });

  test("links a run that a person started to the project's GitHub repository", () => {
    expect(resolveSourceProvider(null, { fullName: "doxa/demo" })).toBe("github");
    expect(resolveSourceProvider("github", null)).toBe("github");
    expect(resolveSourceProvider(null, null)).toBeNull();
  });

  test("links a re-run to its failed run and the failed run to its newest re-run", () => {
    expect(
      resolveRerunLinks([
        { type: "rerun_started", linkedJobId: "job-newest" },
        { type: "rerun_of", linkedJobId: "job-failed" },
        { type: "rerun_started", linkedJobId: "job-older" },
      ]),
    ).toEqual({ rerunOfId: "job-failed", rerunId: "job-newest" });
    expect(resolveRerunLinks([])).toEqual({ rerunOfId: null, rerunId: null });
  });

  test("keeps a superseded preview domain but disables its visit URL", () => {
    expect(
      resolveDeployment({
        publicationMode: "preview",
        docsVersionId: "version-1",
        versionNumber: 2,
        site: { publishedVersionId: "production-version" },
        productionDomains: [],
        previewChannel: {
          hostname: "pr-42.demo.doxa.page",
          currentVersionId: "version-2",
        },
        wentLive: true,
        env: {},
      }),
    ).toEqual({
      environment: "preview",
      isCurrent: false,
      state: "replaced",
      docsVersionId: "version-1",
      versionNumber: 2,
      visitUrl: null,
      domains: [
        {
          hostname: "pr-42.demo.doxa.page",
          url: "https://pr-42.demo.doxa.page",
          role: "preview",
        },
      ],
    });
  });

  test("shows no preview URL for the closed channel of an ended pull request", () => {
    expect(
      resolveDeployment({
        publicationMode: "preview",
        docsVersionId: "a1b2c3d4-e5f6-4789-8123-456789abcdef",
        versionNumber: 2,
        site: { publishedVersionId: "production-version" },
        projectSlug: "demo",
        productionDomains: [],
        previewChannel: { hostname: "demo-pr-42.doxa.page", currentVersionId: null },
        env: { DOCS_BASE_DOMAIN: "doxa.page" },
      }),
    ).toMatchObject({ isCurrent: false, domains: [{ role: "permanent" }] });
  });

  test("says whether a run's version is live, in review, replaced, or never published", () => {
    expect(resolveDeploymentState(true, { awaitsReview: true, wentLive: true })).toBe("live");
    expect(resolveDeploymentState(false, { awaitsReview: true })).toBe("in_review");
    expect(resolveDeploymentState(false, { wentLive: true })).toBe("replaced");
    expect(resolveDeploymentState(false, {})).toBe("not_published");
  });

  test("knows that a version went live only when it was published, as itself or through its review", () => {
    const production = {
      publicationMode: "production" as const,
      status: "succeeded" as const,
      docsVersionId: "version-1",
      versionStatus: "staged" as const,
      review: null,
    };
    expect(didGenerationGoLive({ ...production, versionStatus: "published" })).toBe(true);
    expect(
      didGenerationGoLive({ ...production, review: { status: "published", publishedVersionId: "version-2" } }),
    ).toBe(true);
    // A failed run, a run in review, and a run whose review was discarded never went live.
    expect(didGenerationGoLive({ ...production, status: "failed", docsVersionId: null, versionStatus: null })).toBe(false);
    expect(didGenerationGoLive({ ...production, review: { status: "open", publishedVersionId: null } })).toBe(false);
    expect(didGenerationGoLive({ ...production, review: { status: "discarded", publishedVersionId: null } })).toBe(false);

    const preview = { ...production, publicationMode: "preview" as const, versionStatus: "staged" as const };
    expect(didGenerationGoLive(preview)).toBe(true);
    expect(didGenerationGoLive({ ...preview, status: "cancelled", docsVersionId: null })).toBe(false);
  });

  test("orders verified production domains before the generated domain", () => {
    expect(
      resolveDeployment({
        publicationMode: "production",
        docsVersionId: "version-1",
        versionNumber: 3,
        site: { publishedVersionId: "version-1" },
        projectSlug: "demo",
        productionDomains: [
          {
            hostname: "docs.example.com",
            kind: "custom_domain",
            status: "active",
            verificationStatus: "verified",
          },
          {
            hostname: "pending.example.com",
            kind: "custom_domain",
            status: "disabled",
            verificationStatus: "pending",
          },
        ],
        previewChannel: null,
        env: { DOCS_BASE_DOMAIN: "doxa.page" },
      }),
    ).toMatchObject({
      isCurrent: true,
      visitUrl: "https://docs.example.com",
      domains: [
        {
          hostname: "docs.example.com",
          url: "https://docs.example.com",
          role: "production",
        },
        {
          hostname: "demo.doxa.page",
          url: "https://demo.doxa.page",
          role: "generated",
        },
      ],
    });
  });

  test("does not invent a generated domain before the docs site exists", () => {
    expect(
      resolveDeployment({
        publicationMode: "production",
        docsVersionId: null,
        versionNumber: null,
        site: null,
        projectSlug: "demo",
        productionDomains: [],
        previewChannel: null,
        env: { DOCS_BASE_DOMAIN: "doxa.page" },
      }),
    ).toMatchObject({
      isCurrent: false,
      visitUrl: null,
      domains: [],
    });
  });

  test("falls back to the permanent URL for a superseded production generation", () => {
    expect(
      resolveDeployment({
        publicationMode: "production",
        docsVersionId: "a1b2c3d4-e5f6-4789-8123-456789abcdef",
        versionNumber: 2,
        site: { publishedVersionId: "another-version" },
        projectSlug: "demo",
        productionDomains: [],
        previewChannel: null,
        env: { DOCS_BASE_DOMAIN: "doxa.page" },
      }),
    ).toMatchObject({
      isCurrent: false,
      visitUrl: "https://demo--a1b2c3d4e5f6.doxa.page",
      domains: [
        {
          hostname: "demo.doxa.page",
          role: "generated",
        },
        {
          hostname: "demo--a1b2c3d4e5f6.doxa.page",
          role: "permanent",
        },
      ],
    });
  });

  test("falls back to the permanent URL for a superseded pull request preview", () => {
    expect(
      resolveDeployment({
        publicationMode: "preview",
        docsVersionId: "a1b2c3d4-e5f6-4789-8123-456789abcdef",
        versionNumber: 2,
        site: { publishedVersionId: "production-version" },
        projectSlug: "demo",
        productionDomains: [],
        previewChannel: {
          hostname: "demo-pr-42.doxa.page",
          currentVersionId: "another-version",
        },
        env: { DOCS_BASE_DOMAIN: "doxa.page" },
      }),
    ).toMatchObject({
      isCurrent: false,
      visitUrl: "https://demo--a1b2c3d4e5f6.doxa.page",
      domains: [{ role: "preview" }, { role: "permanent" }],
    });
  });

  test("keeps the production URL first for a serving generation", () => {
    expect(
      resolveDeployment({
        publicationMode: "production",
        docsVersionId: "a1b2c3d4-e5f6-4789-8123-456789abcdef",
        versionNumber: 2,
        site: { publishedVersionId: "promoted-version" },
        projectSlug: "demo",
        productionDomains: [],
        previewChannel: null,
        isServingProduction: true,
        env: { DOCS_BASE_DOMAIN: "doxa.page" },
      }).visitUrl,
    ).toBe("https://demo.doxa.page");
  });
});
