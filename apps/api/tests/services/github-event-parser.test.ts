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
  headRepositoryId?: number | null;
  authorAssociation?: string;
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
        repo:
          overrides.headRepositoryId === null
            ? null
            : repository({ id: overrides.headRepositoryId ?? 123456 }),
      },
      author_association: overrides.authorAssociation ?? "OWNER",
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
      change: "renamed",
      repository: {
        externalId: "123456",
        installationExternalId: "789",
        fullName: "doxahq/new-name",
        name: "new-name",
      },
    });
  });

  // SECURITY REGRESSION GUARDRAIL (SEC-026, Decision 3): no author is trusted
  // on a fork. The event is marked, so the orchestrator previews nothing.
  test.each(["OWNER", "MEMBER", "COLLABORATOR", "NONE", "CONTRIBUTOR", "FIRST_TIMER"])(
    "marks a fork pull request by a %s author as from a fork",
    (authorAssociation) => {
      const result = parseGitHubEvent({
        eventName: "pull_request",
        deliveryId: "delivery-fork",
        payload: pullRequestPayload({ headRepositoryId: 654321, authorAssociation }),
      });
      expect(result.outcome).toBe("normalized");
      if (result.outcome !== "normalized") return;
      expect(result.events[0]).toMatchObject({
        kind: "change_proposal",
        change: { externalId: "987654", fromFork: true, authorIsBot: false },
      });
    },
  );

  test("marks a pull request from a deleted fork as from a fork", () => {
    const result = parseGitHubEvent({
      eventName: "pull_request",
      deliveryId: "delivery-deleted-fork",
      payload: pullRequestPayload({ headRepositoryId: null, authorAssociation: "NONE" }),
    });
    expect(result.outcome === "normalized" && result.events[0]).toMatchObject({ change: { fromFork: true } });
  });

  test("keeps a merged fork pull request for the merge trigger", () => {
    const result = parseGitHubEvent({
      eventName: "pull_request",
      deliveryId: "delivery-fork-merged",
      payload: pullRequestPayload({ action: "closed", merged: true, headRepositoryId: 654321, authorAssociation: "NONE" }),
    });
    expect(result.outcome === "normalized" && result.events[0]).toMatchObject({
      action: "closed",
      change: { merged: true, fromFork: true },
    });
  });

  test("reads the bot type of the author", () => {
    const payload = pullRequestPayload();
    const result = parseGitHubEvent({
      eventName: "pull_request",
      deliveryId: "delivery-bot",
      payload: { ...payload, pull_request: { ...payload.pull_request, user: { ...payload.pull_request.user, login: "dependabot[bot]", type: "Bot" } } },
    });
    expect(result.outcome === "normalized" && result.events[0]).toMatchObject({
      change: { authorIsBot: true, fromFork: false, author: { handle: "dependabot[bot]" } },
    });
  });

  test("carries the repository size of a pull request event", () => {
    const withSize = parseGitHubEvent({
      eventName: "pull_request",
      deliveryId: "delivery-size",
      payload: pullRequestPayload({ repository: { size: 2_000_000 } }),
    });
    expect(withSize.outcome === "normalized" && withSize.events[0]).toMatchObject({
      change: { repositorySizeKb: 2_000_000 },
    });

    const withoutSize = parseGitHubEvent({
      eventName: "pull_request",
      deliveryId: "delivery-no-size",
      payload: pullRequestPayload(),
    });
    expect(withoutSize.outcome === "normalized" && withoutSize.events[0] && "change" in withoutSize.events[0]
      ? withoutSize.events[0].change
      : null).not.toHaveProperty("repositorySizeKb");

    // A bad size is dropped; the event still parses.
    const badSize = parseGitHubEvent({
      eventName: "pull_request",
      deliveryId: "delivery-bad-size",
      payload: pullRequestPayload({ repository: { size: "big" } }),
    });
    expect(badSize.outcome).toBe("normalized");
  });

  test("accepts a same-repository pull request whatever the author association", () => {
    const result = parseGitHubEvent({
      eventName: "pull_request",
      deliveryId: "delivery-same-repo",
      payload: pullRequestPayload({ authorAssociation: "CONTRIBUTOR" }),
    });
    expect(result.outcome === "normalized" && result.events[0]).toMatchObject({ change: { fromFork: false } });
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
    const [event] = result.events;
    expect(event?.kind === "change_proposal" ? event.repository.visibility : null).toBe("public");
  });

  test("turns a base change into a base_changed event and ignores every other edit", () => {
    const moved = parseGitHubEvent({
      eventName: "pull_request",
      deliveryId: "delivery-edited-base",
      payload: { ...pullRequestPayload({ action: "edited", baseRef: "release" }), changes: { base: { ref: { from: "main" } } } },
    });
    const retitled = parseGitHubEvent({
      eventName: "pull_request",
      deliveryId: "delivery-edited-title",
      payload: { ...pullRequestPayload({ action: "edited" }), changes: { title: { from: "Old title" } } },
    });

    expect(moved.outcome).toBe("normalized");
    if (moved.outcome !== "normalized") return;
    expect(moved.events[0]).toMatchObject({
      kind: "change_proposal",
      action: "base_changed",
      change: { baseRef: "release" },
    });
    expect(retitled).toEqual({ outcome: "irrelevant", reason: "unsupported_action" });
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
          change: action,
          repository: {
            provider: "github",
            externalId: "1268777599",
            installationExternalId: "789",
            visibility: action === "added" ? "private" : "public",
            fullName: "ipenywis/flagforge",
            name: "flagforge",
          },
        }],
      });
    });

    test.each([
      ["created", "created"],
      ["deleted", "deleted"],
      ["suspend", "suspended"],
      ["unsuspend", "unsuspended"],
      ["new_permissions_accepted", "permissions_accepted"],
    ] as const)("parses installation %s as one installation event", (action, lifecycleAction) => {
      // A suspend lists no repositories; the event is about the installation.
      const repositories = action === "created" ? [shortRepository(1), shortRepository(2)] : undefined;
      const result = parseGitHubEvent({
        eventName: "installation",
        deliveryId: "delivery-install",
        payload: { action, installation: { id: 789 }, ...(repositories ? { repositories } : {}) },
      });

      expect(result).toEqual({
        outcome: "normalized",
        events: [{
          kind: "installation_lifecycle",
          deliveryId: "delivery-install",
          provider: "github",
          installationExternalId: "789",
          action: lifecycleAction,
        }],
      });
    });

    test("keeps the sender of installation created as the installer", () => {
      const result = parseGitHubEvent({
        eventName: "installation",
        deliveryId: "delivery-install",
        payload: {
          action: "created",
          installation: { id: 789 },
          sender: { id: 5150, login: "octo-admin", type: "User" },
        },
      });

      expect(result).toEqual({
        outcome: "normalized",
        events: [expect.objectContaining({
          kind: "installation_lifecycle",
          action: "created",
          sender: { externalId: "5150", login: "octo-admin" },
        })],
      });
    });

    test("drops the sender of other installation actions", () => {
      const result = parseGitHubEvent({
        eventName: "installation",
        deliveryId: "delivery-install",
        payload: { action: "deleted", installation: { id: 789 }, sender: { id: 5150, login: "octo-admin" } },
      });

      expect(result.outcome === "normalized" && result.events[0]).not.toHaveProperty("sender");
    });
  });
});

describe("check_run events from a Doxa preview check", () => {
  const jobId = "11111111-1111-4111-8111-111111111111";

  function checkRunPayload(overrides: {
    action?: string;
    name?: string;
    externalId?: string | null;
    identifier?: string;
  } = {}) {
    return {
      action: overrides.action ?? "rerequested",
      installation: { id: 789 },
      repository: repository(),
      sender: { id: 7, login: "maintainer" },
      check_run: {
        id: 139388875497,
        name: overrides.name ?? "Doxa documentation preview",
        external_id: overrides.externalId === undefined ? jobId : overrides.externalId,
        head_sha: headSha,
      },
      ...(overrides.identifier === undefined ? {} : { requested_action: { identifier: overrides.identifier } }),
    };
  }

  const parse = (payload: unknown) =>
    parseGitHubEvent({ eventName: "check_run", deliveryId: "delivery-1", payload });

  test.each([
    ["rerequested", undefined, "rerun"],
    ["requested_action", "retry_preview", "retry_action"],
  ] as const)("normalizes %s into a retry of the check's job", (action, identifier, trigger) => {
    expect(parse(checkRunPayload({ action, identifier }))).toEqual({
      outcome: "normalized",
      events: [
        {
          kind: "review_run_retry",
          deliveryId: "delivery-1",
          repository: {
            provider: "github",
            externalId: "123456",
            installationExternalId: "789",
            visibility: "private",
            defaultBranch: "main",
          },
          externalRunId: "139388875497",
          jobId,
          trigger,
          requestedBy: { externalId: "7", login: "maintainer" },
        },
      ],
    });
  });

  test.each(["created", "completed"])("ignores the %s action", (action) => {
    expect(parse(checkRunPayload({ action }))).toEqual({ outcome: "irrelevant", reason: "unsupported_action" });
  });

  test("ignores a button that is not Retry preview", () => {
    expect(parse(checkRunPayload({ action: "requested_action", identifier: "something_else" }))).toEqual({
      outcome: "irrelevant",
      reason: "unsupported_action",
    });
  });

  test.each([
    ["another check name", { name: "CI" }],
    ["no external ID", { externalId: null }],
    ["an external ID that is not a job ID", { externalId: "build-42" }],
  ])("ignores a check with %s", (_name, overrides) => {
    expect(parse(checkRunPayload(overrides))).toEqual({ outcome: "irrelevant", reason: "foreign_check" });
  });

  test("returns malformed when the sender is missing", () => {
    const { sender: _sender, ...payload } = checkRunPayload();
    expect(parse(payload)).toEqual({ outcome: "malformed", reason: "invalid_payload" });
  });
});
