import { sql, type SQL } from "drizzle-orm";
import { schema } from "@doxahq/db";

/**
 * The branch that a project's production generations read: the branch the
 * project chose, else the repository's default branch on GitHub. A query
 * that selects it must inner join `projects` and `github_repositories`.
 */
export function productionBranchSql(): SQL<string> {
  return sql<string>`coalesce(${schema.projects.productionBranch}, ${schema.githubRepositories.defaultBranch})`;
}

/**
 * `productionBranchSql` for a query that left joins the repository: null
 * without one, also when the project kept a branch from an earlier one.
 */
export function optionalProductionBranchSql(): SQL<string | null> {
  return sql<string | null>`case when ${schema.githubRepositories.id} is null then null else coalesce(${schema.projects.productionBranch}, ${schema.githubRepositories.defaultBranch}) end`;
}
