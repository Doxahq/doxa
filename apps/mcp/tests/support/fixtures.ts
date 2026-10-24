import type {
  DocsContentOverviewDto,
  DocsContentPageDetailDto,
  DocsContentWorkingDto,
  DocsDomainCollectionDto,
  GenerationDetailDto,
  GenerationJobDto,
  GitHubRepositoryDto,
  JobEventDto,
  ProjectDto,
} from "@doxahq/contracts";
import type {
  DocsBranchDiff,
  DocsBranchList,
  DocsBranchStatus,
  DocsPublicationPage,
  NamedDocsBranch,
} from "@doxahq/contracts/docs-branches";
import { FREE_PLAN_ENTITLEMENTS } from "@doxahq/contracts/entitlements";
import type { RuntimeSearchResult } from "@doxahq/docs-search";
import { siteConfigSchema } from "@doxahq/site-config";

export const OWNER = "owner-user";
export const OTHER = "other-user";
/** Owned by OWNER, inside every test grant. */
export const PROJECT_A = "11111111-1111-4111-8111-111111111111";
/** Owned by OWNER, outside a grant that selects only PROJECT_A. */
export const PROJECT_B = "22222222-2222-4222-8222-222222222222";
/** Owned by OTHER. */
export const PROJECT_OTHER = "33333333-3333-4333-8333-333333333333";
export const GENERATION_ID = "44444444-4444-4444-8444-444444444444";
export const BRANCH_ID = "55555555-5555-4555-8555-555555555555";
export const VERSION_ID = "66666666-6666-4666-8666-666666666666";
export const SITE_ID = "77777777-7777-4777-8777-777777777777";
export const GRANT_REF = "88888888-8888-4888-8888-888888888888";
/** The OAuth client of the harness actor. */
export const CLIENT_ID = "client-1";
export const CLIENT_NAME = "Test Agent";
/** A branch that the user created in the dashboard. */
export const USER_BRANCH_ID = "99999999-9999-4999-8999-999999999999";
/** A branch that another client created for OWNER: same member, other client. */
export const OTHER_AGENT_BRANCH_ID = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";
/** Created by CLIENT_ID for OTHER: same client, another team member. */
export const TEAMMATE_AGENT_BRANCH_ID = "dddddddd-dddd-4ddd-8ddd-dddddddddddd";

export const CREATED_AT = "2026-10-01T10:00:00.000Z";

/** A team owned by OTHER. OWNER joins it only when a test sets `teamRole`. */
export const TEAM_ID = "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb";
export const TEAM_NAME = "Acme Docs";
/** Owned by OTHER and shared by TEAM_ID. */
export const PROJECT_TEAM = "cccccccc-cccc-4ccc-8ccc-cccccccccccc";

export const PROJECT_OWNERS: Record<string, string> = {
  [PROJECT_A]: OWNER,
  [PROJECT_B]: OWNER,
  [PROJECT_OTHER]: OTHER,
  [PROJECT_TEAM]: OTHER,
};

/** The team of each team project; other projects are personal. */
export const PROJECT_TEAMS: Record<string, string> = { [PROJECT_TEAM]: TEAM_ID };

export function project(id: string): ProjectDto {
  return {
    id,
    name: `Project ${id.slice(0, 4)}`,
    slug: `project-${id.slice(0, 4)}`,
    githubRepositoryId: null,
    repositoryFullName: null,
    publishedVersionId: VERSION_ID,
    docsUrl: null,
    team: PROJECT_TEAMS[id] === undefined ? null : { id: TEAM_ID, name: TEAM_NAME },
  };
}

export function generationJob(projectId: string): GenerationJobDto {
  return {
    id: GENERATION_ID,
    projectId,
    status: "succeeded",
    docsVersionId: VERSION_ID,
    errorMessage: null,
    createdAt: CREATED_AT,
    updatedAt: CREATED_AT,
  };
}

export function generationDetail(projectId: string): GenerationDetailDto {
  return {
    ...generationJob(projectId),
    trigger: "manual",
    author: {
      kind: "user",
      displayName: "Owner",
      githubLogin: null,
      avatarUrl: null,
    },
    source: {
      provider: null,
      repositoryFullName: null,
      repositoryUrl: null,
      branch: null,
      branchUrl: null,
      commit: null,
      changeProposal: null,
    },
    deployment: {
      environment: "production",
      isCurrent: true,
      state: "live",
      docsVersionId: VERSION_ID,
      versionNumber: 1,
      visitUrl: null,
      domains: [],
    },
    actions: {
      canPromote: false,
      canDelete: false,
      promoteBlockedReason: "already_production",
      deleteBlockedReason: "serving_production",
      canRerun: false,
      rerunBlockedReason: "not_finished",
      canResume: false,
      resumeBlockedReason: "not_resumable",
    },
    rerunLinks: { rerunOfId: null, rerunId: null },
    flaggedPages: [],
    referenceSource: null,
  };
}

export function jobEvents(count: number): JobEventDto[] {
  return Array.from({ length: count }, (_, index) => ({
    id: `event-${index + 1}`,
    jobId: GENERATION_ID,
    sequence: index + 1,
    source: "worker",
    type: "page_written",
    message: `Wrote page ${index + 1}.`,
    data: { title: `Page ${index + 1}`, secret: "not for agents" },
    createdAt: CREATED_AT,
  }));
}

export const GITHUB_REPOSITORIES: GitHubRepositoryDto[] = Array.from(
  { length: 3 },
  (_, index) => ({
    id: `repo-${index + 1}`,
    githubRepoId: `${1000 + index}`,
    fullName: `acme/repo-${index + 1}`,
    owner: "acme",
    name: `repo-${index + 1}`,
    defaultBranch: "main",
    isPrivate: false,
  }),
);

export function overview(projectId: string): DocsContentOverviewDto {
  return {
    projectId,
    projectSlug: project(projectId).slug,
    siteId: SITE_ID,
    publishedVersion: {
      id: VERSION_ID,
      versionNumber: 3,
      createdAt: CREATED_AT,
    },
    working: {
      branchId: null,
      baseVersionId: VERSION_ID,
      editedHrefs: [],
      changeCount: 0,
      revision: 4,
      createdAt: null,
      updatedAt: null,
      isBaseCurrent: true,
    },
    entitlements: { ...FREE_PLAN_ENTITLEMENTS },
    siteConfig: {
      published: siteConfigSchema.parse({ name: "Demo" }),
      working: null,
    },
    pages: [
      {
        href: "/",
        title: "Home",
        sourcePath: "pages/index.mdx",
        status: "published",
        icon: null,
      },
      {
        href: "/install",
        title: "Install",
        sourcePath: "pages/install.mdx",
        status: "edited",
        icon: "download",
      },
    ],
    navigation: [
      {
        slug: "default",
        label: "Docs",
        isDefault: true,
        groups: [{ heading: null, groupIndex: null, hrefs: ["/", "/install"] }],
      },
    ],
  };
}

export function pageDetail(href: string): DocsContentPageDetailDto {
  return {
    href,
    title: "Install",
    sourcePath: "pages/install.mdx",
    status: "edited",
    publishedContent: "# Install\n\nPublished.",
    workingContent: "# Install\n\nWorking.",
  };
}

export function working(revision: number): DocsContentWorkingDto {
  return {
    branchId: BRANCH_ID,
    baseVersionId: VERSION_ID,
    editedHrefs: ["/install"],
    changeCount: 1,
    revision,
    createdAt: CREATED_AT,
    updatedAt: CREATED_AT,
    isBaseCurrent: true,
  };
}

export function branchList(): DocsBranchList {
  return {
    branches: [
      namedBranch(BRANCH_ID, "agent-install", {
        kind: "agent",
        clientId: CLIENT_ID,
        clientName: CLIENT_NAME,
        userId: OWNER,
      }),
      namedBranch(USER_BRANCH_ID, "draft-intro", { kind: "user" }),
      namedBranch(OTHER_AGENT_BRANCH_ID, "agent-other", {
        kind: "agent",
        clientId: "client-2",
        clientName: "Other Agent",
        userId: OWNER,
      }),
      namedBranch(TEAMMATE_AGENT_BRANCH_ID, "agent-teammate", {
        kind: "agent",
        clientId: CLIENT_ID,
        clientName: CLIENT_NAME,
        userId: OTHER,
      }),
    ],
    maxBranchesPerSite: 10,
  };
}

function namedBranch(
  id: string,
  name: string,
  createdBy: NamedDocsBranch["createdBy"],
): NamedDocsBranch {
  return {
    id,
    kind: "named",
    purpose: "user",
    name,
    baseVersionId: VERSION_ID,
    createdFromBranchId: null,
    createdBy,
    revision: 2,
    changeCount: 1,
    createdAt: CREATED_AT,
    updatedAt: CREATED_AT,
  };
}

export function branchDiff(): DocsBranchDiff {
  return {
    baseVersionId: VERSION_ID,
    mainVersionId: VERSION_ID,
    behind: false,
    pages: [
      {
        href: "/install",
        title: "Install",
        change: "edited",
        diff: "--- a/source/install/index.mdx\n+++ b/source/install/index.mdx\n@@ -1 +1 @@\n-# Old\n+# Install\n",
        lineCount: 5,
        truncated: false,
      },
    ],
    structure: [],
    siteSettings: null,
    assets: [],
  };
}

export function branchStatus(revision: number): DocsBranchStatus {
  return {
    branch: { id: BRANCH_ID, kind: "named", name: "agent-install", revision },
    baseVersionId: VERSION_ID,
    main: {
      versionId: VERSION_ID,
      versionNumber: 3,
      latestPublication: {
        kind: "editor",
        actorName: "Owner",
        createdAt: CREATED_AT,
      },
    },
    behind: false,
    publicationsSinceBase: 0,
    changeCount: 1,
    preview: null,
  };
}

export function publicationPage(): DocsPublicationPage {
  return {
    publications: [
      {
        id: VERSION_ID,
        kind: "editor",
        versionId: VERSION_ID,
        versionNumber: 3,
        actor: { id: OWNER, name: "Owner" },
        branchName: "agent-install",
        summary: { changedPageCount: 1 },
        agent: null,
        createdAt: CREATED_AT,
        isCurrent: true,
        canRestore: false,
      },
    ],
    nextCursor: null,
  };
}

export function domainCollection(projectId: string): DocsDomainCollectionDto {
  return {
    domains: [
      {
        id: "domain-1",
        projectId,
        siteId: SITE_ID,
        hostname: "project-1111.doxa.page",
        kind: "doxa_subdomain",
        status: "active",
        verificationStatus: "verified",
        provider: null,
        providerHostnameId: null,
        providerStatus: null,
        providerSslStatus: null,
        ownershipVerification: null,
        ownershipVerificationHttp: null,
        sslValidationRecords: [],
        dnsRecord: null,
        verificationError: null,
        routingStatus: "healthy",
        routingHttpStatus: 200,
        routingError: null,
        routingCheckedAt: CREATED_AT,
        createdAt: CREATED_AT,
        updatedAt: CREATED_AT,
      },
    ],
    customDomainLimit: 1,
  };
}

export const SEARCH_RESULTS: RuntimeSearchResult[] = [
  {
    id: "install",
    slug: "install",
    title: "Install",
    breadcrumb: ["Docs"],
    snippetLine: "Run the installer.",
    snippetAnchor: "setup",
    score: 3.5,
    terms: ["install"],
  },
];
