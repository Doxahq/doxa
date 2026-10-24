import type { DocsDomainDto, DocsPageMdxIssues, ProjectDto } from "@doxahq/contracts";
import type { PublishDocsBranchResult } from "@doxahq/contracts/docs-branches";
import { vi } from "vitest";
import { agentActor, dashboardActor } from "../../../src/services/agent-access/actor";
import { membershipPolicy } from "../../support/in-memory-project-access";
import type { ActionAccessPolicy } from "../../../src/services/agent-actions/action-access";
import type { ActionServices, PublishBranchState } from "../../../src/services/agent-actions/action-ports";

export const OWNER = "owner-1";
export const STRANGER = "stranger-1";
export const PROJECT = "11111111-1111-4111-8111-111111111111";
export const BRANCH = "22222222-2222-4222-8222-222222222222";
export const BASE_VERSION = "33333333-3333-4333-8333-333333333333";
export const GRANT = "44444444-4444-4444-8444-444444444444";

export function ownerAgent(scopes: readonly string[] = ["publish", "projects:write", "domains:write", "generation:run"]) {
  return agentActor({
    userId: OWNER,
    clientId: "client-1",
    clientName: "Claude Code",
    grantRef: GRANT,
    scopes,
    projectScope: { kind: "all" },
  });
}

export const ownerDashboard = () => dashboardActor(OWNER);

/** The real membership policy over personal projects, without a database. */
export function fakeAccess(owners: Record<string, string> = { [PROJECT]: OWNER }): ActionAccessPolicy {
  return membershipPolicy(Object.fromEntries(Object.entries(owners).map(([id, owner]) => [id, { owner }])));
}

export interface FakeServicesState {
  branch: PublishBranchState | null;
  mainVersionId: string;
  projectName: string | null;
  activeGeneration: boolean;
  /** The branch pages that fail the MDX check. */
  mdxIssues: DocsPageMdxIssues[];
}

export function fakeServices(overrides: Partial<FakeServicesState> = {}) {
  const state: FakeServicesState = {
    branch: {
      branchId: BRANCH,
      branchName: "agent-rate-limits",
      revision: 3,
      baseVersionId: BASE_VERSION,
      mainVersionId: BASE_VERSION,
      changeCount: 2,
    },
    mainVersionId: BASE_VERSION,
    projectName: "Acme",
    activeGeneration: false,
    mdxIssues: [],
    ...overrides,
  };
  const published: PublishDocsBranchResult = {
    publicationId: "55555555-5555-4555-8555-555555555555",
    versionId: "66666666-6666-4666-8666-666666666666",
    versionNumber: 4,
    branchErased: false,
  };
  const publish = vi.fn(async () => published);
  const deleteProject = vi.fn(async () => ({ projectId: PROJECT, siteId: null, storageEntryIds: [] }));
  const services: ActionServices = {
    publish: { readBranch: async () => state.branch, mdxIssues: async () => state.mdxIssues, publish },
    liveSite: { liveUrl: async () => "https://acme.doxa.page" },
    restore: {
      mainVersionId: async () => state.mainVersionId,
      restore: async () => ({ publicationId: published.publicationId, versionId: published.versionId }),
    },
    domains: {
      find: async () => null,
      create: async (): Promise<DocsDomainDto> => {
        throw new Error("not used");
      },
      remove: async () => true,
      refresh: async () => null,
    },
    projects: {
      find: async () => (state.projectName ? { id: PROJECT, name: state.projectName } : null),
      createExample: async (): Promise<ProjectDto> => {
        throw new Error("not used");
      },
      createForRepository: async (): Promise<ProjectDto> => {
        throw new Error("not used");
      },
      delete: deleteProject,
    },
    generation: {
      hasActiveGeneration: async () => state.activeGeneration,
      start: async () => ({ outcome: "not_found" }),
      cancel: async () => ({ outcome: "already_finished" }),
    },
  };
  return { services, state, publish, deleteProject };
}
