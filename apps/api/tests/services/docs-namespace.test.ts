import { describe, expect, test, vi } from "vitest";

import { createAvailableSlug } from "../../src/repositories/projects";
import {
  createChannelHostnameCandidates,
  createPreviewHostnameCandidates,
} from "../../src/repositories/preview-channels";
import {
  isHostnameAvailable,
  type DocsNamespaceLookup,
} from "../../src/services/docs-namespace";

describe("isHostnameAvailable", () => {
  test("rejects a label used by an existing preview channel", async () => {
    const lookup = createLookup({ previewHostnameExists: true });

    await expect(
      isHostnameAvailable(lookup, {
        label: "acme-pr-5",
        hostname: "acme-pr-5.doxa.page",
      }),
    ).resolves.toBe(false);
    expect(lookup.hasPreviewHostname).toHaveBeenCalledWith(
      "acme-pr-5.doxa.page",
    );
  });

  test("checks every namespace source for an unused hostname", async () => {
    const lookup = createLookup();

    await expect(
      isHostnameAvailable(lookup, {
        label: "acme",
        hostname: "acme.doxa.page",
      }),
    ).resolves.toBe(true);
    expect(lookup.hasProjectSlug).toHaveBeenCalledOnce();
    expect(lookup.hasSiteSlug).toHaveBeenCalledOnce();
    expect(lookup.hasPreviewHostname).toHaveBeenCalledOnce();
    expect(lookup.hasCustomHostname).toHaveBeenCalledOnce();
  });
});

describe("namespace-aware hostname allocation", () => {
  test.each([
    {
      projectId: "project-1",
      projectSlug: "acme",
      changeExternalId: "pull-request-5",
      changeNumber: 5,
      expected: [
        "acme-pr-5.doxa.page",
        "acme-pr-5-a933fcd0.doxa.page",
        "acme-pr-5-a933fcd04f45b4a0.doxa.page",
      ],
    },
    {
      projectId: "project-2",
      projectSlug: "docs",
      changeExternalId: "change-9",
      changeNumber: 9,
      expected: [
        "docs-pr-9.doxa.page",
        "docs-pr-9-6622429b.doxa.page",
        "docs-pr-9-6622429b0376e747.doxa.page",
      ],
    },
  ])(
    "keeps the existing pull request candidate sequence for $projectSlug",
    async (input) => {
      const candidates = await createPreviewHostnameCandidates({
        projectId: input.projectId,
        projectSlug: input.projectSlug,
        provider: "github",
        changeExternalId: input.changeExternalId,
        changeNumber: input.changeNumber,
        docsBaseDomain: "doxa.page",
        isAvailable: async () => true,
      });

      expect(candidates).toEqual(input.expected);
    },
  );

  test("moves a project slug away from an existing preview hostname", async () => {
    const isAvailable = vi.fn(
      async ({ label }: { label: string }) => label !== "acme-pr-5",
    );

    await expect(
      createAvailableSlug("acme-pr-5", isAvailable, "doxa.page"),
    ).resolves.toBe("acme-pr-5-2");
    expect(isAvailable).toHaveBeenNthCalledWith(1, {
      label: "acme-pr-5",
      hostname: "acme-pr-5.doxa.page",
    });
  });

  test("uses the digest preview hostname when the plain label is taken", async () => {
    const isAvailable = vi.fn(
      async ({ label }: { label: string }) => label !== "acme-pr-5",
    );

    const candidates = await createPreviewHostnameCandidates({
      projectId: "project-1",
      projectSlug: "acme",
      provider: "github",
      changeExternalId: "pull-request-5",
      changeNumber: 5,
      docsBaseDomain: "doxa.page",
      isAvailable,
    });

    expect(candidates).toHaveLength(2);
    expect(candidates[0]).toMatch(/^acme-pr-5-[a-f0-9]{8}\.doxa\.page$/);
    expect(candidates[1]).toMatch(/^acme-pr-5-[a-f0-9]{16}\.doxa\.page$/);
    expect(candidates).not.toContain("acme-pr-5.doxa.page");
  });

  test("fits branch labels and keeps the random suffix at the end", async () => {
    const candidates = await createChannelHostnameCandidates({
      stem: `${"long-project-".repeat(6)}-br-feature`,
      identity: "branch-1",
      requiredSuffix: "0123456789abcdef",
      docsBaseDomain: "doxa.page",
      isAvailable: async () => true,
    });

    expect(candidates).toHaveLength(3);
    for (const hostname of candidates) {
      const [label] = hostname.split(".");
      expect(label?.length).toBeLessThanOrEqual(63);
      expect(label).toMatch(/-0123456789abcdef$/);
    }
  });
});

function createLookup(
  input: {
    previewHostnameExists?: boolean;
  } = {},
): DocsNamespaceLookup {
  return {
    hasProjectSlug: vi.fn(async () => false),
    hasSiteSlug: vi.fn(async () => false),
    hasPreviewHostname: vi.fn(async () => input.previewHostnameExists ?? false),
    hasCustomHostname: vi.fn(async () => false),
  };
}
