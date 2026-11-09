import { z } from "zod";
import { agentActionKindSchema } from "./approval-requests";
import { docsPublicationKindSchema } from "./docs-branch-primitives";
import { generationJobStatusSchema } from "./index";

/**
 * `GET /projects/:projectId/overview`: what the project Overview shows beside
 * the project itself. It is a read over the tables that already hold each
 * fact, so it can never disagree with them.
 */

/** Who did something. The dashboard filters the activity by `kind`. */
export const projectActivityActorSchema = z
  .object({
    kind: z.enum(["doxabot", "person", "agent"]),
    name: z.string().min(1),
  })
  .strict();

const activityEventBase = {
  id: z.string().min(1),
  occurredAt: z.iso.datetime(),
  actor: projectActivityActorSchema,
};

const generationEventFields = {
  ...activityEventBase,
  generationId: z.uuid(),
};

export const projectActivityEventSchema = z.discriminatedUnion("type", [
  z
    .object({
      ...activityEventBase,
      type: z.literal("published"),
      publicationKind: docsPublicationKindSchema,
      versionNumber: z.number().int().positive(),
      /** Null when the publication did not record its pages. */
      changedPageCount: z.number().int().nonnegative().nullable(),
    })
    .strict(),
  z
    .object({ ...generationEventFields, type: z.literal("generation_staged") })
    .strict(),
  z
    .object({ ...generationEventFields, type: z.literal("generation_failed") })
    .strict(),
  z
    .object({
      ...generationEventFields,
      type: z.literal("generation_cancelled"),
    })
    .strict(),
  z
    .object({
      ...generationEventFields,
      type: z.literal("preview_built"),
      pullRequestNumber: z.number().int().positive(),
    })
    .strict(),
  z
    .object({
      ...activityEventBase,
      type: z.literal("agent_action"),
      actionKind: agentActionKindSchema,
    })
    .strict(),
]);

/** The newest publication of the site, the version that visitors see. */
export const projectLatestPublicationSchema = z
  .object({
    kind: docsPublicationKindSchema,
    versionNumber: z.number().int().positive(),
    publishedAt: z.iso.datetime(),
    actor: projectActivityActorSchema,
  })
  .strict();

/** The newest Doxabot preview of a pull request that is still open. */
export const projectOpenPreviewSchema = z
  .object({
    pullRequestNumber: z.number().int().positive(),
    status: generationJobStatusSchema,
    /** Null until the pull request has a preview site. */
    previewUrl: z.url().nullable(),
    updatedAt: z.iso.datetime(),
  })
  .strict();

export const projectOverviewSchema = z
  .object({
    latestPublication: projectLatestPublicationSchema.nullable(),
    /** The commit of the newest published generation; null if there is none. */
    lastSyncedRevision: z.string().min(1).nullable(),
    /** Newest first. */
    activity: z.array(projectActivityEventSchema),
    /** Newest first. */
    openPreviews: z.array(projectOpenPreviewSchema),
  })
  .strict();

export type ProjectActivityActor = z.infer<typeof projectActivityActorSchema>;
export type ProjectActivityEvent = z.infer<typeof projectActivityEventSchema>;
export type ProjectLatestPublication = z.infer<
  typeof projectLatestPublicationSchema
>;
export type ProjectOpenPreview = z.infer<typeof projectOpenPreviewSchema>;
export type ProjectOverview = z.infer<typeof projectOverviewSchema>;
