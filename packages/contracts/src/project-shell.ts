import { z } from "zod";
import { approvalRequestListSchema } from "./approval-requests";
import { docsBranchListSchema } from "./docs-branches";
import { doxabotSettingsSchema, pendingMergesSchema } from "./doxabot";
import { generationReviewResponseSchema } from "./generation-reviews";
import {
  docsDomainCollectionSchema,
  generationJobSchema,
  generationsPageSchema,
  projectSchema,
} from "./index";
import { teamRoleSchema } from "./teams";

/**
 * `GET /projects/:projectId/shell`: the reads of the project Overview in one
 * request. The API checks the session and the project access once, then
 * reads every section at the same time.
 *
 * Each section is `{ data }` or `{ error }`. `data` is the exact body of the
 * endpoint that the section replaces, so a client can seed that endpoint's
 * cache entry with it. `error` is the error body of that endpoint, with its
 * HTTP status. One failed or slow section never fails the others: a section
 * that does not answer in time is `{ error: { status: 504, ... } }` with
 * `details.code` "timeout", and the client can call its endpoint instead.
 *
 * The whole request fails only when the project itself cannot be read: 401
 * without a session, 404 when the user has no access, 403 when the role
 * lacks `project.read`, as for `GET /projects/:projectId`.
 */

/** The body of `GET /projects/:projectId`. */
export const projectDetailSchema = z.object({
  project: projectSchema,
  latestJob: generationJobSchema.nullable(),
  /** The viewer's role, so the dashboard hides what it cannot do. */
  role: teamRoleSchema,
});

/** The body of `GET /projects/:projectId/doxabot`. */
export const doxabotSettingsResponseSchema = z.object({
  settings: doxabotSettingsSchema,
});

/** The error body of an endpoint (`{ error: { message, details } }`) with its status. */
export const projectShellSectionErrorSchema = z.object({
  status: z.number().int().min(400).max(599),
  message: z.string(),
  details: z.unknown().optional(),
});

export function projectShellSectionSchema<T extends z.ZodType>(data: T) {
  return z.union([
    z.object({ data }).strict(),
    z.object({ error: projectShellSectionErrorSchema }).strict(),
  ]);
}

/**
 * The sections and the endpoints they replace. Each one keeps the
 * capability check of its endpoint.
 */
export const projectShellSchema = z
  .object({
    /** `GET /projects/:projectId` */
    project: projectShellSectionSchema(projectDetailSchema),
    /** `GET /projects/:projectId/generation-review` */
    generationReview: projectShellSectionSchema(generationReviewResponseSchema),
    /** `GET /projects/:projectId/doxabot/pending-merges` */
    pendingMerges: projectShellSectionSchema(pendingMergesSchema),
    /** `GET /projects/:projectId/doxabot` */
    doxabot: projectShellSectionSchema(doxabotSettingsResponseSchema),
    /** `GET /projects/:projectId/generations?limit=20` (the first page) */
    generations: projectShellSectionSchema(generationsPageSchema),
    /** `GET /projects/:projectId/branches` */
    branches: projectShellSectionSchema(docsBranchListSchema),
    /** `GET /projects/:projectId/approval-requests?status=pending` */
    pendingApprovalRequests: projectShellSectionSchema(approvalRequestListSchema),
    /** `GET /projects/:projectId/docs-domains` */
    docsDomains: projectShellSectionSchema(docsDomainCollectionSchema),
  })
  .strict();

export type ProjectDetail = z.infer<typeof projectDetailSchema>;
export type ProjectShellSectionError = z.infer<
  typeof projectShellSectionErrorSchema
>;
export type ProjectShellSection<T> =
  | { data: T }
  | { error: ProjectShellSectionError };
export type ProjectShell = z.infer<typeof projectShellSchema>;
export type ProjectShellSectionKey = keyof ProjectShell;

export const PROJECT_SHELL_SECTION_KEYS = Object.keys(
  projectShellSchema.shape,
) as ProjectShellSectionKey[];
