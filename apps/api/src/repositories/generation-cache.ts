import { eq } from "drizzle-orm";
import { createDb, schema, type DbEnv } from "@doxahq/db";

export interface GenerationCacheState {
  siteId: string;
  clearedAt: string | null;
}

/**
 * Clearing a project's generation cache records an instant instead of deleting
 * anything. Published documentation keeps serving, and baseline resolution then
 * ignores every version created at or before that instant, so the next
 * generation analyzes the repository from scratch.
 */
export class GenerationCacheRepository {
  private readonly db;

  constructor(env: DbEnv) {
    this.db = createDb(env);
  }

  async getForProject(
    projectId: string,
  ): Promise<GenerationCacheState | null> {
    const [site] = await this.db
      .select({
        siteId: schema.docsSites.id,
        clearedAt: schema.docsSites.generationBaselineResetAt,
      })
      .from(schema.docsSites)
      .where(eq(schema.docsSites.projectId, projectId))
      .limit(1);

    if (!site) return null;
    return {
      siteId: site.siteId,
      clearedAt: site.clearedAt?.toISOString() ?? null,
    };
  }

  async clearForProject(
    projectId: string,
    clearedAt: Date = new Date(),
  ): Promise<GenerationCacheState | null> {
    const [site] = await this.db
      .update(schema.docsSites)
      .set({
        generationBaselineResetAt: clearedAt,
        updatedAt: new Date(),
      })
      .where(eq(schema.docsSites.projectId, projectId))
      .returning({
        siteId: schema.docsSites.id,
        clearedAt: schema.docsSites.generationBaselineResetAt,
      });

    if (!site) return null;
    return {
      siteId: site.siteId,
      clearedAt: site.clearedAt?.toISOString() ?? null,
    };
  }
}
