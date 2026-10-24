import { describe, expect, test } from "vitest";
import { parseGitHubEvent } from "../../src/services/doxabot/github-event-parser";

const baseSha = "a".repeat(40);
const headSha = "b".repeat(40);
const sourceUpdatedAt = "2026-07-23T10:00:00.000Z";

function repository(overrides: Record<string, unknown> = {}) {
  return {
    id: 123456,
    name: "doxa",
    full_name: "doxahq/doxa",
    private: true,
    default_branch: "main",
    ...overrides,
  };
}

function pullRequestPayload(overrides: {
  action?: string;
  repository?: Record<string, unknown>;
  draft?: boolean;
  merged?: boolean;
  baseRef?: string;
  headRepositoryId?: number;
} = {}) {
  return {
    action: overrides.action ?? "opened",
    number: 42,
    installation: { id: 789 },
    repository: repository(overrides.repository),
    pull_request: {
      id: 987654,
      user: {
        id: 1,
        login: "octocat",
        avatar_url: "https://avatars.githubusercontent.com/u/1?v=4",
      },
      updated_at: sourceUpdatedAt,
      draft: overrides.draft ?? false,
      merged: overrides.merged ?? false,
      base: {
        ref: overrides.baseRef ?? "main",
        sha: baseSha,
      },
      head: {
        sha: headSha,
        repo: repository({
          id: overrides.headRepositoryId ?? 123456,
        }),
      },
    },
  };
}

describe("GitHub event parser", () => {
  test("returns malformed for invalid payloads without throwing", () => {
    expect(parseGitHubEvent({
      eventName: "pull_request",
      deliveryId: "delivery-1",
      payload: { action: "opened" },
    })).toEqual({
      outcome: "malformed",
      reason: "invalid_payload",
    });
    expect(parseGitHubEvent({
      eventName: "push",
      deliveryId: "",
      payload: {},
    })).toEqual({
      outcome: "malformed",
      reason: "invalid_payload",
    });
  });

  test("returns typed irrelevant outcomes for unsupported events and actions", () => {
    expect(parseGitHubEvent({
      eventName: "issues",
      deliveryId: "delivery-2",
      payload: {},
    })).toEqual({
      outcome: "irrelevant",
      reason: "unsupported_event",
    });
    expect(parseGitHubEvent({
      eventName: "pull_request",
      deliveryId: "delivery-3",
      payload: pullRequestPayload({ action: "labeled" }),
    })).toEqual({
      outcome: "irrelevant",
      reason: "unsupported_action",
    });
  });

  test("uses stable repository IDs across repository renames", () => {
    const result = parseGitHubEvent({
      eventName: "repository",
      deliveryId: "delivery-4",
      payload: {
        action: "renamed",
        installation: { id: 789 },
        repository: repository({
          name: "new-name",
          full_name: "doxahq/new-name",
        }),
        changes: {
          repository: {
            name: { from: "old-name" },
          },
        },
      },
    });

    expect(result.outcome).toBe("normalized");
    if (result.outcome !== "normalized") return;
    expect(result.events[0]).toMatchObject({
      kind: "repository_lifecycle",
      action: "updated",
      repository: {
        externalId: "123456",
        installationExternalId: "789",
      },
    });
  });

  test("accepts pull requests whose head comes from a fork", () => {
    const result = parseGitHubEvent({
      eventName: "pull_request",
      deliveryId: "delivery-5",
      payload: pullRequestPayload({ headRepositoryId: 654321 }),
    });

    expect(result.outcome).toBe("normalized");
    if (result.outcome !== "normalized") return;
    expect(result.events[0]).toMatchObject({
      kind: "change_proposal",
      change: {
        externalId: "987654",
        number: 42,
        author: {
          externalId: "1",
          handle: "octocat",
          avatarUrl: "https://avatars.githubusercontent.com/u/1?v=4",
        },
        headRevision: { commitSha: headSha },
        sourceUpdatedAt,
      },
      repository: { externalId: "123456" },
    });
  });

  test("preserves non-default pull request bases for policy filtering later", () => {
    const result = parseGitHubEvent({
      eventName: "pull_request",
      deliveryId: "delivery-6",
      payload: pullRequestPayload({ baseRef: "release" }),
    });

    expect(result.outcome).toBe("normalized");
    if (result.outcome !== "normalized") return;
    expect(result.events[0]).toMatchObject({
      kind: "change_proposal",
      repository: { defaultBranch: "main" },
      change: {
        baseRef: "release",
        baseRevision: { commitSha: baseSha },
      },
    });
  });

  test("normalizes only pushes to the payload repository default branch", () => {
    const defaultPush = parseGitHubEvent({
      eventName: "push",
      deliveryId: "delivery-7",
      payload: {
        ref: "refs/heads/main",
        before: baseSha,
        after: headSha,
        installation: { id: 789 },
        repository: repository(),
      },
    });
    const featurePush = parseGitHubEvent({
      eventName: "push",
      deliveryId: "delivery-8",
      payload: {
        ref: "refs/heads/feature",
        before: baseSha,
        after: headSha,
        installation: { id: 789 },
        repository: repository(),
      },
    });

    expect(defaultPush).toEqual({
      outcome: "normalized",
      events: [{
        kind: "default_branch_push",
        deliveryId: "delivery-7",
        repository: {
          provider: "github",
          externalId: "123456",
          installationExternalId: "789",
          visibility: "private",
          defaultBranch: "main",
        },
        ref: "refs/heads/main",
        beforeRevision: { commitSha: baseSha },
        afterRevision: { commitSha: headSha },
      }],
    });
    expect(featurePush).toEqual({
      outcome: "irrelevant",
      reason: "non_default_branch_push",
    });
  });

  test("preserves public repository visibility", () => {
    const result = parseGitHubEvent({
      eventName: "pull_request",
      deliveryId: "delivery-9",
      payload: pullRequestPayload({
        repository: { private: false },
      }),
    });

    expect(result.outcome).toBe("normalized");
    if (result.outcome !== "normalized") return;
    expect(result.events[0]?.repository.visibility).toBe("public");
  });

  test("preserves draft pull requests", () => {
    const result = parseGitHubEvent({
      eventName: "pull_request",
      deliveryId: "delivery-10",
      payload: pullRequestPayload({ draft: true }),
    });

    expect(result.outcome).toBe("normalized");
    if (result.outcome !== "normalized") return;
    expect(result.events[0]).toMatchObject({
      kind: "change_proposal",
      action: "opened",
      change: { draft: true },
    });
  });

  test("preserves merged state on closed pull requests", () => {
    const result = parseGitHubEvent({
      eventName: "pull_request",
      deliveryId: "delivery-11",
      payload: pullRequestPayload({
        action: "closed",
        merged: true,
      }),
    });

    expect(result.outcome).toBe("normalized");
    if (result.outcome !== "normalized") return;
    expect(result.events[0]).toMatchObject({
      kind: "change_proposal",
      action: "closed",
      change: { merged: true },
    });
  });

  test("normalizes installation repository additions as lifecycle events", () => {
    const result = parseGitHubEvent({
      eventName: "installation_repositories",
      deliveryId: "delivery-12",
      payload: {
        action: "added",
        installation: { id: 789 },
        repositories_added: [
          repository({ id: 111 }),
          repository({ id: 222, private: false }),
        ],
        repositories_removed: [],
      },
    });

    expect(result.outcome).toBe("normalized");
    if (result.outcome !== "normalized") return;
    expect(result.events).toHaveLength(2);
    expect(result.events).toEqual(expect.arrayContaining([
      expect.objectContaining({
        action: "connected",
        repository: expect.objectContaining({ externalId: "111" }),
      }),
      expect.objectContaining({
        action: "connected",
        repository: expect.objectContaining({
          externalId: "222",
          visibility: "public",
        }),
      }),
    ]));
  });

  describe("installation events with GitHub's short repository objects", () => {
    /** The repository object of `installation` and `installation_repositories`: no default branch. */
    const shortRepository = (id: number, isPrivate = true) => ({
      id,
      node_id: `R_${id}`,
      name: "flagforge",
      full_name: "ipenywis/flagforge",
      private: isPrivate,
    });

    test.each([
      ["added", "connected", { repositories_added: [shortRepository(1268777599)], repositories_removed: [] }],
      ["removed", "disconnected", { repositories_added: [], repositories_removed: [shortRepository(1268777599, false)] }],
    ] as const)("parses installation_repositories %s", (action, lifecycleAction, repositories) => {
      const result = parseGitHubEvent({
        eventName: "installation_repositories",
        deliveryId: `delivery-${action}`,
        payload: { action, installation: { id: 789 }, repository_selection: "selected", ...repositories },
      });

      expect(result).toEqual({
        outcome: "normalized",
        events: [{
          kind: "repository_lifecycle",
          deliveryId: `delivery-${action}`,
          action: lifecycleAction,
          repository: {
            provider: "github",
            externalId: "1268777599",
            installationExternalId: "789",
            visibility: action === "added" ? "private" : "public",
          },
        }],
      });
    });

    test("parses an installation with its short repository list", () => {
      const result = parseGitHubEvent({
        eventName: "installation",
        deliveryId: "delivery-install",
        payload: { action: "created", installation: { id: 789 }, repositories: [shortRepository(1), shortRepository(2)] },
      });

      expect(result.outcome).toBe("normalized");
      if (result.outcome !== "normalized") return;
      expect(result.events.map((event) => event.kind === "repository_lifecycle" ? event.repository.externalId : null))
        .toEqual(["1", "2"]);
    });
  });
});
