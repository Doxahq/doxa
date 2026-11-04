import { eq } from "drizzle-orm";
import { createDb, schema, type DbEnv } from "@doxahq/db";

/**
 * The docs site of a project. Callers authorize the project first: this
 * lookup checks no user.
 */
export class DocsSiteIdsRepository {
  private readonly db;

  constructor(env: DbEnv) {
    this.db = createDb(env);
  }

  async forProject(projectId: string): Promise<string | null> {
    const [site] = await this.db
      .select({ id: schema.docsSites.id })
      .from(schema.docsSites)
      .where(eq(schema.docsSites.projectId, projectId))
      .limit(1);
    return site?.id ?? null;
  }
}
