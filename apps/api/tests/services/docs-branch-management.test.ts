import { describe, expect, test, vi } from "vitest";

import {
  branchIdSchema,
  siteIdSchema,
  versionIdSchema,
} from "@doxahq/contracts/docs-branches";

import { DocsBranchService } from "../../src/services/docs-branches/branch-service";
import type { StoredNamedDocsBranch } from "../../src/repositories/docs-branch-records";
import { InMemoryDocsBranchStore } from "../support/in-memory-docs-branches";

const ownerId = "owner";
const memberId = "member";
const agentCreator = {
  kind: "agent",
  clientId: "client-1",
  clientName: "Test Agent",
  userId: memberId,
} as const;
const agent = { clientId: agentCreator.clientId, userId: memberId };
const projectId = "00000000-0000-4000-8000-000000000002";
const siteId = siteIdSchema.parse("00000000-0000-4000-8000-000000000001");
const mainVersionId = versionIdSchema.parse(
  "00000000-0000-4000-8000-000000000003",
);

describe("named branch management", () => {
  test("forks every working change and keeps the source base", async () => {
    const { service, store } = createSubject();
    const source = namedBranch({
      id: "10000000-0000-4000-8000-000000000001",
      name: "source",
    });

    store.addBranch(source);
    store.setChanges(source.id, [
      {
        branchId: source.id,
        path: "source/index.mdx",
        kind: "upsert",
        content: "# Draft",
        contentSha256: "draft-hash",
        byteSize: 7,
        updatedByUserId: ownerId,
        origin: "editor",
        updatedAt: new Date("2026-09-24T01:00:00.000Z"),
      },
      {
        branchId: source.id,
        path: "settings/site.json",
        kind: "delete",
        content: null,
        contentSha256: null,
        byteSize: 0,
        updatedByUserId: ownerId,
        origin: "mcp",
        updatedAt: new Date("2026-09-24T02:00:00.000Z"),
      },
    ]);

    const fork = await service.create({
      userId: ownerId,
      projectId,
      request: {
        name: "forked",
        from: { kind: "branch", branchId: source.id },
      },
    });

    expect(fork).toMatchObject({
      kind: "named",
      name: "forked",
      baseVersionId: source.baseVersionId,
      createdFromBranchId: source.id,
      changeCount: 2,
    });
    expect(
      await store.listChanges({
        userId: ownerId,
        projectId,
        branch: fork.id,
      }),
    ).toEqual([
      expect.objectContaining({
        branchId: fork.id,
        path: "source/index.mdx",
        content: "# Draft",
        origin: "editor",
      }),
      expect.objectContaining({
        branchId: fork.id,
        path: "settings/site.json",
        kind: "delete",
        content: null,
        origin: "mcp",
      }),
    ]);
  });

  test("serializes parallel creations at the branch limit", async () => {
    const { service } = createSubject(10);

    for (let index = 0; index < 9; index += 1) {
      await createFromMain(service, `branch-${index}`);
    }

    const outcomes = await Promise.allSettled([
      createFromMain(service, "parallel-a"),
      createFromMain(service, "parallel-b"),
    ]);
    const list = await service.list({ userId: ownerId, projectId });

    expect(
      outcomes.filter(({ status }) => status === "fulfilled"),
    ).toHaveLength(1);
    expect(outcomes.filter(({ status }) => status === "rejected")).toHaveLength(
      1,
    );
    expect(list.branches).toHaveLength(10);
  });

  test("returns the limit and duplicate-name issues", async () => {
    const { service, store } = createSubject(1);

    await store.getOrCreateHiddenBranch({ userId: ownerId, projectId });

    await createFromMain(service, "one");

    await expect(createFromMain(service, "two")).rejects.toMatchObject({
      code: "plan_limit",
      details: { key: "docs.branches_per_site", limit: 1, used: 1 },
    });

    const duplicateSubject = createSubject();
    await createFromMain(duplicateSubject.service, "same-name");

    await expect(
      createFromMain(duplicateSubject.service, "same-name"),
    ).rejects.toMatchObject({
      issues: [expect.objectContaining({ code: "branch_name_taken" })],
    });
  });

  test("renames and erases only an owned named branch", async () => {
    const { service, store } = createSubject();
    const branch = await createFromMain(service, "before");

    const renamed = await service.rename({
      userId: ownerId,
      projectId,
      branchId: branch.id,
      request: { name: "after" },
    });

    expect(renamed.name).toBe("after");

    await service.erase({
      actor: { userId: ownerId, origin: "editor" },
      projectId,
      branchId: branch.id,
    });

    expect(
      await store.getBranchForUser({
        userId: ownerId,
        projectId,
        branch: branch.id,
      }),
    ).toBeNull();
  });

  test("collects the preview of an erased branch after the commit", async () => {
    const { service, store, collectStorage } = createSubject();
    const branch = await createFromMain(service, "with-preview");
    store.previewEntries.set(branch.id, "gc-entry-1");

    await service.erase({
      actor: { userId: ownerId, origin: "editor" },
      projectId,
      branchId: branch.id,
    });

    expect(collectStorage).toHaveBeenCalledWith(["gc-entry-1"]);
  });

  test("does not rename a branch to a name that is already in use", async () => {
    const { service } = createSubject();
    await createFromMain(service, "first");
    const second = await createFromMain(service, "second");

    await expect(
      service.rename({
        userId: ownerId,
        projectId,
        branchId: second.id,
        request: { name: "first" },
      }),
    ).rejects.toMatchObject({
      issues: [expect.objectContaining({ code: "branch_name_taken" })],
    });
  });

  test.each(["agent", "mcp"] as const)(
    "rejects an erase requested with the %s origin",
    async (origin) => {
      const { service, store } = createSubject();
      const branch = await createFromMain(service, "protected");

      await expect(
        service.erase({
          actor: { userId: ownerId, origin },
          projectId,
          branchId: branch.id,
        }),
      ).rejects.toMatchObject({ code: "invalid" });

      expect(
        await store.getBranchForUser({
          userId: ownerId,
          projectId,
          branch: branch.id,
        }),
      ).not.toBeNull();
    },
  );

  test("records the agent that created a branch and lists it", async () => {
    const { service } = createSubject();
    const agentBranch = await service.create({
      userId: ownerId,
      projectId,
      request: { name: "agent-docs", from: { kind: "main" } },
      createdBy: agentCreator,
    });
    const userBranch = await createFromMain(service, "user-docs");

    expect(agentBranch.createdBy).toEqual(agentCreator);
    expect(userBranch.createdBy).toEqual({ kind: "user" });
    const { branches } = await service.list({ userId: ownerId, projectId });
    expect(
      Object.fromEntries(
        branches.flatMap((branch) =>
          branch.kind === "named" ? [[branch.name, branch.createdBy]] : [],
        ),
      ),
    ).toEqual({ "agent-docs": agentCreator, "user-docs": { kind: "user" } });
  });

  test("lets an agent erase a branch that its client created", async () => {
    const { service, store, collectStorage } = createSubject();
    const branch = await service.create({
      userId: ownerId,
      projectId,
      request: { name: "agent-docs", from: { kind: "main" } },
      createdBy: agentCreator,
    });
    store.previewEntries.set(branch.id, "preview-entry");

    await service.eraseOwnedByAgent({
      userId: ownerId,
      projectId,
      branchId: branch.id,
      agent,
    });

    expect(
      await store.getBranchForUser({ userId: ownerId, projectId, branch: branch.id }),
    ).toBeNull();
    expect(collectStorage).toHaveBeenCalledWith(["preview-entry"]);
  });

  test.each([
    ["a dashboard branch", undefined],
    ["the same member's branch from another client", { ...agentCreator, clientId: "client-other" }],
    ["another member's branch from the same client", { ...agentCreator, userId: "other-member" }],
    ["a branch whose member was deleted", { ...agentCreator, userId: null }],
  ] as const)("answers branch_not_found to an agent for %s", async (_label, createdBy) => {
    const { service, store, collectStorage } = createSubject();
    const branch = await service.create({
      userId: ownerId,
      projectId,
      request: { name: "kept", from: { kind: "main" } },
      ...(createdBy ? { createdBy } : {}),
    });

    await expect(
      service.eraseOwnedByAgent({
        userId: ownerId,
        projectId,
        branchId: branch.id,
        agent,
      }),
    ).rejects.toMatchObject({ code: "branch_not_found", message: "Branch not found." });
    expect(
      await store.getBranchForUser({ userId: ownerId, projectId, branch: branch.id }),
    ).not.toBeNull();
    expect(collectStorage).not.toHaveBeenCalled();
  });

  test("keeps an agent branch while its publish request is pending", async () => {
    const { service, store } = createSubject();
    const requestId = "30000000-0000-4000-8000-000000000001";
    const branch = await service.create({
      userId: ownerId,
      projectId,
      request: { name: "agent-docs", from: { kind: "main" } },
      createdBy: agentCreator,
    });
    store.pendingPublishRequests.set(branch.id, requestId);

    await expect(
      service.eraseOwnedByAgent({
        userId: ownerId,
        projectId,
        branchId: branch.id,
        agent,
      }),
    ).rejects.toMatchObject({ code: "publish_pending", details: { requestId } });
    expect(
      await store.getBranchForUser({ userId: ownerId, projectId, branch: branch.id }),
    ).not.toBeNull();
  });

  test("lets the user erase an agent branch from the dashboard", async () => {
    const { service, store } = createSubject();
    const branch = await service.create({
      userId: ownerId,
      projectId,
      request: { name: "agent-docs", from: { kind: "main" } },
      createdBy: agentCreator,
    });

    await service.erase({
      actor: { userId: ownerId, origin: "editor" },
      projectId,
      branchId: branch.id,
    });

    expect(
      await store.getBranchForUser({ userId: ownerId, projectId, branch: branch.id }),
    ).toBeNull();
  });

  test("does not manage a branch from another site", async () => {
    const { service, store } = createSubject();
    const otherSiteId = siteIdSchema.parse(
      "20000000-0000-4000-8000-000000000001",
    );
    const otherProjectId = "20000000-0000-4000-8000-000000000002";
    const otherVersionId = versionIdSchema.parse(
      "20000000-0000-4000-8000-000000000003",
    );
    const foreignBranch = namedBranch({
      id: "20000000-0000-4000-8000-000000000004",
      name: "foreign",
      siteId: otherSiteId,
      baseVersionId: otherVersionId,
    });

    store.addSite(ownerId, {
      id: otherSiteId,
      projectId: otherProjectId,
      projectName: "Other",
      projectSlug: "other",
      mainVersionId: otherVersionId,
      mainVersionNumber: 1,
      mainArtifactPrefix: `sites/${otherSiteId}/versions/${otherVersionId}`,
      mainCreatedAt: new Date("2026-09-24T00:00:00.000Z"),
    });
    store.addBranch(foreignBranch);

    await expect(
      service.create({
        userId: ownerId,
        projectId,
        request: {
          name: "invalid-fork",
          from: { kind: "branch", branchId: foreignBranch.id },
        },
      }),
    ).rejects.toMatchObject({ code: "branch_not_found" });

    await expect(
      service.rename({
        userId: ownerId,
        projectId,
        branchId: foreignBranch.id,
        request: { name: "stolen" },
      }),
    ).rejects.toMatchObject({ code: "branch_not_found" });

    await expect(
      service.erase({
        actor: { userId: ownerId, origin: "editor" },
        projectId,
        branchId: foreignBranch.id,
      }),
    ).rejects.toMatchObject({ code: "branch_not_found" });

    expect(
      await store.getBranchForUser({
        userId: ownerId,
        projectId: otherProjectId,
        branch: foreignBranch.id,
      }),
    ).not.toBeNull();
  });
});

function createSubject(maxBranchesPerSite = 10) {
  const store = new InMemoryDocsBranchStore();

  store.addSite(ownerId, {
    id: siteId,
    projectId,
    projectName: "Example",
    projectSlug: "example",
    mainVersionId,
    mainVersionNumber: 1,
    mainArtifactPrefix: `sites/${siteId}/versions/${mainVersionId}`,
    mainCreatedAt: new Date("2026-09-24T00:00:00.000Z"),
  });

  const collectStorage = vi.fn(async (_entryIds: readonly string[]) => {});
  const service = new DocsBranchService({
    branches: store,
    collectStorage,
    management: {
      branches: store,
      entitlements: {
        async getProjectEntitlements() {
          return { removePoweredBy: false, maxBranchesPerSite };
        },
      },
    },
  });

  return { service, store, collectStorage };
}

function createFromMain(service: DocsBranchService, name: string) {
  return service.create({
    userId: ownerId,
    projectId,
    request: { name, from: { kind: "main" } },
  });
}

function namedBranch(input: {
  id: string;
  name: string;
  siteId?: typeof siteId;
  baseVersionId?: typeof mainVersionId;
}): StoredNamedDocsBranch {
  const now = new Date("2026-09-24T00:00:00.000Z");

  return {
    id: branchIdSchema.parse(input.id),
    siteId: input.siteId ?? siteId,
    kind: "named",
    purpose: "user",
    name: input.name,
    ownerUserId: ownerId,
    baseVersionId: input.baseVersionId ?? mainVersionId,
    createdFromBranchId: null,
    createdBy: { kind: "user" },
    revision: 0,
    previewRevision: null,
    createdAt: now,
    updatedAt: now,
  };
}
