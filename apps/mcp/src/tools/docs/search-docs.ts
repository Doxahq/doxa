import { z } from "zod";
import { BRANCH_SCAN_LIMITS } from "../../services/branch-search-scan";
import { defineMcpTool } from "../../tool-definition";
import { branchInput, projectIdInput, READ_ONLY_ANNOTATIONS } from "../shared";

const MAX_SCAN_MB = BRANCH_SCAN_LIMITS.maxBytes / (1024 * 1024);

export const searchDocsTool = defineMcpTool({
  name: "search_docs",
  title: "Search docs",
  description: `Searches the docs of a project. Without a branch, or with "main", it searches the live, published site. With a branch ID, it also searches the branch's unpublished pages: changed pages come from the branch (status "edited"), the other pages from the live site (status "published"), and pages the branch deleted are left out. A branch search reads at most ${BRANCH_SCAN_LIMITS.maxPages} changed pages or ${MAX_SCAN_MB} MB of MDX; past that, truncated is true and truncatedReason says which limit stopped it.`,
  scope: "docs:read",
  cost: "read",
  annotations: READ_ONLY_ANNOTATIONS,
  input: z
    .object({
      projectId: projectIdInput,
      query: z.string().trim().min(2).max(200),
      limit: z.number().int().min(1).max(20).default(8),
      branch: branchInput,
    })
    .strict(),
  output: z
    .object({
      results: z.array(
        z
          .object({
            href: z.string(),
            title: z.string(),
            breadcrumb: z.array(z.string()),
            snippet: z.string(),
            anchor: z.string().nullable(),
            score: z.number(),
            status: z.enum(["edited", "published"]),
          })
          .strict(),
      ),
      truncated: z.boolean(),
      truncatedReason: z.enum(["page_limit", "size_limit"]).nullable(),
    })
    .strict(),
  async run(context, input) {
    const authorized = await context.authorize(input.projectId, "docs.read");
    const outcome = await context.services.search.search({
      userId: authorized.ownerUserId,
      projectId: authorized.projectId,
      query: input.query,
      limit: input.limit,
      ...(input.branch ? { branch: input.branch } : {}),
    });
    return {
      results: outcome.results.map((result) => ({
        href: result.slug,
        title: result.title,
        breadcrumb: result.breadcrumb,
        snippet: result.snippetLine,
        anchor: result.snippetAnchor ?? null,
        score: result.score,
        status: result.status,
      })),
      truncated: outcome.truncated !== null,
      truncatedReason: outcome.truncated,
    };
  },
});
