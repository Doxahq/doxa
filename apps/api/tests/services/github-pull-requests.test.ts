import type { NormalizedChangeProposalEvent } from "@doxahq/contracts";
import type { DoxabotAutomationContext } from "../../src/repositories/doxabot-settings";
import { GitHubPullRequestStateResolver } from "../../src/services/doxabot/github-pull-requests";
import { describe, expect, test, vi } from "vitest";

const baseRevision = "a".repeat(40);
const headRevision = "b".repeat(40);

const context: DoxabotAutomationContext = {
  projectId: "11111111-1111-4111-8111-111111111111",
  ownerUserId: "owner-user",
  repositoryExternalId: "123456",
  installationExternalId: "789",
  repositoryOwner: "doxahq",
  repositoryName: "doxa",
  repositoryVisibility: "private",
  productionBranch: "main",
  storedEnabled: true,
  mergeTrigger: "batched",
  allowedBotLogins: [],
  connectionIssue: null,
  hasPublishedVersion: true,
  publishedBaseline: { versionId: "22222222-2222-4222-8222-222222222222", sourceRevision: baseRevision },
};

const event: NormalizedChangeProposalEvent = {
  kind: "change_proposal",
  deliveryId: "delivery-1",
  action: "synchronize",
  repository: {
    provider: "github",
    externalId: "123456",
    installationExternalId: "789",
    visibility: "private",
    defaultBranch: "main",
  },
  change: {
    externalId: "987654",
    number: 42,
    draft: false,
    merged: false,
    baseRef: "main",
    baseRevision: { commitSha: baseRevision },
    headRevision: { commitSha: headRevision },
    sourceUpdatedAt: "2026-07-23T10:00:00.000Z",
  },
};

describe("GitHub pull-request state resolver", () => {
  test("loads current state with an exact repository-scoped token", async () => {
    const createInstallationToken = vi.fn(async () => "ghs_scoped");
    const fetchMock = vi.fn(async function (this: unknown) {
      expect(this).toBe(globalThis);
      return Response.json({
        id: 987654,
        number: 42,
        state: "closed",
        draft: false,
        merged: true,
        updated_at: "2026-07-23T10:01:00.000Z",
        base: { ref: "main", sha: baseRevision },
        head: { sha: headRevision },
      });
    });
    const resolver = new GitHubPullRequestStateResolver({
      createInstallationToken,
      fetch: fetchMock,
    });

    await expect(
      resolver.getCurrent({ context, event }),
    ).resolves.toEqual({
      externalId: "987654",
      number: 42,
      draft: false,
      state: "merged",
      baseRef: "main",
      baseRevision,
      headRevision,
      sourceUpdatedAt: new Date("2026-07-23T10:01:00.000Z"),
    });
    expect(createInstallationToken).toHaveBeenCalledWith({
      installationId: "789",
      scope: {
        repositoryIds: [123456],
        permissions: {
          metadata: "read",
          pull_requests: "read",
        },
      },
    });
    expect(fetchMock).toHaveBeenCalledWith(
      "https://api.github.com/repos/doxahq/doxa/pulls/42",
      expect.objectContaining({
        method: "GET",
        headers: expect.objectContaining({
          authorization: "Bearer ghs_scoped",
        }),
      }),
    );
  });

  test("rejects a response for a different pull request", async () => {
    const resolver = new GitHubPullRequestStateResolver({
      createInstallationToken: vi.fn(async () => "ghs_scoped"),
      fetch: vi.fn(async () =>
        Response.json({
          id: 111111,
          number: 42,
          state: "open",
          draft: false,
          merged: false,
          updated_at: "2026-07-23T10:01:00.000Z",
          base: { ref: "main", sha: baseRevision },
          head: { sha: headRevision },
        }),
      ),
    });

    await expect(
      resolver.getCurrent({ context, event }),
    ).rejects.toThrow(
      "GitHub pull request lookup returned an unexpected pull request.",
    );
  });
});
