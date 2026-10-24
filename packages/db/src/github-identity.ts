import { and, eq, isNull } from "drizzle-orm";
import { type DoxaDb } from "./client";
import * as schema from "./schema";

export function createGitHubIdentityStore(db: DoxaDb) {
  return {
    async linkGenerations(input: {
      externalId: string;
      userId: string;
    }): Promise<void> {
      await db
        .update(schema.generationJobs)
        .set({ requestedByUserId: input.userId })
        .where(
          and(
            eq(schema.generationJobs.sourceProvider, "github"),
            eq(
              schema.generationJobs.sourceAuthorExternalId,
              input.externalId,
            ),
            isNull(schema.generationJobs.requestedByUserId),
          ),
        );
    },
    async updateUserProfile(input: {
      userId: string;
      login: string;
    }): Promise<void> {
      await db
        .update(schema.user)
        .set({
          githubLogin: input.login,
          updatedAt: new Date(),
        })
        .where(eq(schema.user.id, input.userId));
    },
  };
}
