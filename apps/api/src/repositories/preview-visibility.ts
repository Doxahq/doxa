import type { DocsPreviewVisibility } from "@doxahq/contracts";
import { createDb, schema } from "@doxahq/db";
import { and, eq } from "drizzle-orm";

import type { Env } from "../env";

export interface ProjectPreviewVisibility {
  previewVisibility: DocsPreviewVisibility;
}

export class PreviewVisibilityRepository {
  private readonly db;

  constructor(env: Env) {
    this.db = createDb(env);
  }

  async getForProject(input: {
    projectId: string;
    userId: string;
  }): Promise<ProjectPreviewVisibility | null> {
    const row = await this.getOwnedSite(input);
    return row
      ? { previewVisibility: row.previewVisibility }
      : null;
  }

  async updateForProject(input: {
    projectId: string;
    userId: string;
    previewVisibility: DocsPreviewVisibility;
  }): Promise<ProjectPreviewVisibility | null> {
    const ownedSite = await this.getOwnedSite(input);
    if (!ownedSite) return null;

    const [row] = await this.db
      .update(schema.docsSites)
      .set({
        previewVisibility: input.previewVisibility,
        updatedAt: new Date(),
      })
      .where(eq(schema.docsSites.id, ownedSite.siteId))
      .returning({
        previewVisibility: schema.docsSites.previewVisibility,
      });

    return row ?? null;
  }

  private async getOwnedSite(input: {
    projectId: string;
    userId: string;
  }) {
    const [row] = await this.db
      .select({
        siteId: schema.docsSites.id,
        previewVisibility: schema.docsSites.previewVisibility,
      })
      .from(schema.docsSites)
      .innerJoin(
        schema.projects,
        eq(schema.docsSites.projectId, schema.projects.id),
      )
      .where(
        and(
          eq(schema.projects.id, input.projectId),
          eq(schema.projects.userId, input.userId),
        ),
      )
      .limit(1);

    return row ?? null;
  }
}
