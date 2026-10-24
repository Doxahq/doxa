import { DocsContentError } from "@doxahq/api/services/docs-content/errors";
import type { McpServices } from "../../src/services/mcp-services";
import type { TeamSummary } from "@doxahq/contracts/teams";
import {
  type AppliedEdits,
  assertKnownBranch,
  CURRENT_REVISION,
  fakeApplyEdits,
  fakeBranchWrites,
} from "./fake-write-services";
import {
  branchList,
  branchStatus,
  domainCollection,
  GENERATION_ID,
  generationDetail,
  generationJob,
  GITHUB_REPOSITORIES,
  jobEvents,
  overview,
  pageDetail,
  project,
  PROJECT_OWNERS,
  publicationPage,
  SEARCH_RESULTS,
  working,
} from "./fixtures";

export interface ServiceCall {
  method: string;
  userId: string | null;
  projectId: string | null;
  /** Set by the docs reads: whether main was read as the published site. */
  published?: boolean;
}

/**
 * Behaves like the SQL ownership joins: a call answers only when the user ID
 * owns the project. Every call is recorded so tests can check the owner ID
 * reached the service.
 */
export function createFakeServices(
  calls: ServiceCall[] = [],
  written: AppliedEdits[] = [],
  teams: TeamSummary[] = [],
): McpServices {
  const owns = (userId: string, projectId: string) =>
    PROJECT_OWNERS[projectId] === userId;
  const record = (
    method: string,
    userId: string | null,
    projectId: string | null,
  ) => calls.push({ method, userId, projectId });

  return {
    projects: {
      async getForUser(userId, projectId) {
        record("projects.getForUser", userId, projectId);
        return owns(userId, projectId) ? project(projectId) : null;
      },
      async latestGeneration(projectId) {
        record("projects.latestGeneration", null, projectId);
        return generationJob(projectId);
      },
      async withDocsUrls(projects) {
        return projects.map((item) => ({
          ...item,
          docsUrl: `http://${item.slug}.localhost:3002`,
        }));
      },
    },
    github: {
      async listRepositories(userId) {
        record("github.listRepositories", userId, null);
        return GITHUB_REPOSITORIES;
      },
    },
    docs: {
      async getOverview(actor, projectId, branch = "main", options = {}) {
        calls.push({
          method: "docs.getOverview",
          userId: actor.userId,
          projectId,
          published: options.published === true,
        });
        if (branch === "main") return overview(projectId);
        assertKnownBranch(branch);
        return { ...overview(projectId), working: working(CURRENT_REVISION) };
      },
      async getPage(actor, projectId, href, _branch, options = {}) {
        calls.push({
          method: "docs.getPage",
          userId: actor.userId,
          projectId,
          published: options.published === true,
        });
        if (href === "/missing")
          throw new DocsContentError("not_found", "Page not found.");
        const page = pageDetail(href);
        return options.published
          ? { ...page, status: "published", workingContent: null }
          : page;
      },
      async applyEdits(actor, projectId, edits, branch = "main", options) {
        record("docs.applyEdits", actor.userId, projectId);
        return fakeApplyEdits(
          written,
          { actor, projectId, branch, edits },
          options,
        );
      },
    },
    search: {
      async search(input) {
        record("search.search", input.userId, input.projectId);
        const onBranch = input.branch !== undefined && input.branch !== "main";
        return {
          results: SEARCH_RESULTS.map((result) => ({
            ...result,
            status: onBranch ? "edited" : "published",
          })),
          truncated: null,
        };
      },
    },
    branches: {
      async list(input) {
        record("branches.list", input.userId, input.projectId);
        return branchList();
      },
      async getStatus(input) {
        record("branches.getStatus", input.userId, input.projectId);
        if (
          input.branch !== "main" &&
          input.branch !== branchList().branches[0]?.id
        ) {
          throw new DocsContentError("branch_not_found", "Branch not found.");
        }
        return branchStatus(2);
      },
      ...fakeBranchWrites(record),
    },
    publications: {
      async list(input) {
        record("publications.list", input.userId, input.projectId);
        return publicationPage();
      },
    },
    domains: {
      async listForProject(input) {
        record("domains.listForProject", input.userId, input.projectId);
        return domainCollection(input.projectId);
      },
    },
    generations: {
      async getDetail(input) {
        record("generations.getDetail", input.userId, input.projectId);
        return input.jobId === GENERATION_ID
          ? generationDetail(input.projectId)
          : null;
      },
      async listEvents() {
        return jobEvents(25);
      },
    },
    teams: {
      async listForUser(userId) {
        record("teams.listForUser", userId, null);
        return teams;
      },
    },
  };
}
