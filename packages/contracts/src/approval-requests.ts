import { z } from "zod";
import { docsPublishStageSchema } from "./docs-branches";

export const APPROVAL_REQUEST_STATUSES = [
  "pending",
  "executing",
  "completed",
  "failed",
  "rejected",
  "cancelled",
  "expired",
  "stale",
] as const;

export const approvalRequestStatusSchema = z.enum(APPROVAL_REQUEST_STATUSES);

export type ApprovalRequestStatus = z.infer<typeof approvalRequestStatusSchema>;

/** A row in one of these states never changes again. */
export const TERMINAL_APPROVAL_REQUEST_STATUSES = [
  "completed",
  "failed",
  "rejected",
  "cancelled",
  "expired",
  "stale",
] as const satisfies readonly ApprovalRequestStatus[];

/**
 * The action kinds of v1. Stored rows can hold a kind that a later release
 * removed, so DTOs carry `actionKind` as a string; narrow with
 * `isAgentActionKind` and show "This action is no longer available" otherwise.
 */
export const AGENT_ACTION_KINDS = [
  "docs.publish",
  "docs.restore",
  "domain.add",
  "domain.remove",
  "project.create",
  "project.delete",
  "generation.start",
  "generation.cancel",
  "domain.check",
] as const;

export const agentActionKindSchema = z.enum(AGENT_ACTION_KINDS);

export type AgentActionKind = z.infer<typeof agentActionKindSchema>;

const AGENT_ACTION_KIND_SET: ReadonlySet<string> = new Set(AGENT_ACTION_KINDS);

export function isAgentActionKind(value: string): value is AgentActionKind {
  return AGENT_ACTION_KIND_SET.has(value);
}

export const reviewSurfaceSchema = z.discriminatedUnion("kind", [
  z.object({ kind: z.literal("publish_menu") }).strict(),
  z.object({ kind: z.literal("approval_page") }).strict(),
]);

export type ReviewSurface = z.infer<typeof reviewSurfaceSchema>;

export const approvalRequestErrorSchema = z
  .object({ code: z.string().min(1), message: z.string() })
  .strict();

export type ApprovalRequestError = z.infer<typeof approvalRequestErrorSchema>;

export const MAX_APPROVAL_TEXT_LENGTH = 500;

/** Payload fields an approval page may show. Every v1 payload is flat. */
export const approvalRequestInputsSchema = z.record(
  z.string(),
  z.union([z.string(), z.number(), z.boolean(), z.null()]),
);

export const approvalRequestSummarySchema = z
  .object({
    id: z.uuid(),
    /** Null only for `project.create`. */
    projectId: z.uuid().nullable(),
    actionKind: z.string().min(1),
    /** False when a release removed the action kind of this row. */
    actionAvailable: z.boolean(),
    status: approvalRequestStatusSchema,
    title: z.string(),
    headline: z.string(),
    effects: z.array(z.string()),
    /** The agent's own text, at most 500 characters. */
    summary: z.string().max(MAX_APPROVAL_TEXT_LENGTH).nullable(),
    /** `name` is the member's name, so a team sees who asked; null when unknown. */
    requestedBy: z
      .object({
        userId: z.string(),
        name: z.string().nullable(),
        clientName: z.string(),
      })
      .strict(),
    decidedBy: z
      .object({ userId: z.string(), name: z.string().nullable() })
      .strict()
      .nullable(),
    decisionNote: z.string().max(MAX_APPROVAL_TEXT_LENGTH).nullable(),
    /**
     * Why the gate applied: `platform_override`, `project_setting`,
     * `user_setting` or `action_default`. Text, so a later source still parses.
     */
    policySource: z.string(),
    reviewSurface: reviewSurfaceSchema,
    /** Set for `docs.publish`, so the approval link can open the branch. */
    branchId: z.uuid().nullable(),
    /** Set when the approval page must ask the user to type this text. */
    confirmationText: z.string().nullable(),
    error: approvalRequestErrorSchema.nullable(),
    createdAt: z.iso.datetime(),
    expiresAt: z.iso.datetime(),
    decidedAt: z.iso.datetime().nullable(),
    completedAt: z.iso.datetime().nullable(),
  })
  .strict();

export type ApprovalRequestSummary = z.infer<
  typeof approvalRequestSummarySchema
>;

export const approvalRequestDetailSchema = approvalRequestSummarySchema
  .extend({
    inputs: approvalRequestInputsSchema,
    result: z.unknown().nullable(),
  })
  .strict();

export type ApprovalRequestDetail = z.infer<typeof approvalRequestDetailSchema>;

/**
 * Why the viewer cannot approve: the project's second-person rule
 * (`require_other_decider`) applies to their own agent's request, or their
 * role lacks `approvals.decide` or the capability of the action itself.
 */
export const APPROVE_BLOCK_REASONS = [
  "other_decider_required",
  "missing_capability",
] as const;

export const approveBlockReasonSchema = z.enum(APPROVE_BLOCK_REASONS);

export type ApproveBlockReason = z.infer<typeof approveBlockReasonSchema>;

/**
 * What the signed-in viewer may do with a request, computed by the server
 * with the same rules as the approve and reject endpoints. It ignores the
 * status: a request that is not pending cannot be decided by anyone.
 * `canReject` needs only `approvals.decide`, so whoever may approve may
 * also reject.
 */
export const approvalRequestViewerSchema = z.discriminatedUnion("canApprove", [
  z
    .object({ canApprove: z.literal(true), reason: z.null(), canReject: z.literal(true) })
    .strict(),
  z
    .object({
      canApprove: z.literal(false),
      reason: approveBlockReasonSchema,
      canReject: z.boolean(),
    })
    .strict(),
]);

export type ApprovalRequestViewer = z.infer<typeof approvalRequestViewerSchema>;

/** The detail as the dashboard reads it: the agent's view plus the viewer. */
export const dashboardApprovalRequestSchema = approvalRequestDetailSchema
  .extend({ viewer: approvalRequestViewerSchema })
  .strict();

export type DashboardApprovalRequest = z.infer<
  typeof dashboardApprovalRequestSchema
>;

export const approvalRequestListSchema = z
  .object({ requests: z.array(approvalRequestSummarySchema) })
  .strict();

export type ApprovalRequestList = z.infer<typeof approvalRequestListSchema>;

export const approvalRequestListQuerySchema = z
  .object({ status: approvalRequestStatusSchema.optional() })
  .strict();

/** What `GET /approval-requests/:id` returns to the web link resolver. */
export const approvalRequestLinkSchema = z
  .object({
    id: z.uuid(),
    projectId: z.uuid().nullable(),
    actionKind: z.string().min(1),
    status: approvalRequestStatusSchema,
    reviewSurface: reviewSurfaceSchema,
    branchId: z.uuid().nullable(),
  })
  .strict();

export type ApprovalRequestLink = z.infer<typeof approvalRequestLinkSchema>;

export const approveApprovalRequestInputSchema = z
  .object({
    /** The project name, for actions that need a typed confirmation. */
    confirmation: z.string().max(200).optional(),
    /**
     * `docs.publish` only: the decider's choice to delete the branch after
     * the publish. Omitted, the agent's choice applies.
     */
    eraseBranch: z.boolean().optional(),
  })
  .strict();

export type ApproveApprovalRequestInput = z.infer<
  typeof approveApprovalRequestInputSchema
>;

export const rejectApprovalRequestInputSchema = z
  .object({
    /** The agent sees this reason. */
    reason: z.string().trim().max(MAX_APPROVAL_TEXT_LENGTH).optional(),
  })
  .strict();

export type RejectApprovalRequestInput = z.infer<
  typeof rejectApprovalRequestInputSchema
>;

/**
 * One event of an approve request sent with `accept: text/event-stream`. The
 * SSE event name equals `type`. Only `docs.publish` sends `stage` events.
 */
export const approveApprovalRequestEventSchema = z.discriminatedUnion("type", [
  z
    .object({ type: z.literal("stage"), stage: docsPublishStageSchema })
    .strict(),
  z
    .object({
      type: z.literal("result"),
      result: dashboardApprovalRequestSchema,
    })
    .strict(),
  z
    .object({
      type: z.literal("error"),
      status: z.number().int().min(400).max(599),
      body: z.unknown(),
    })
    .strict(),
]);

export type ApproveApprovalRequestEvent = z.infer<
  typeof approveApprovalRequestEventSchema
>;

export const APPROVAL_POLL_AFTER_MS = 10_000;

export const pendingApprovalRequestSchema = z
  .object({
    id: z.uuid(),
    status: z.literal("pending"),
    approvalUrl: z.url(),
    expiresAt: z.iso.datetime(),
    pollAfterMs: z.number().int().positive(),
  })
  .strict();

export type PendingApprovalRequest = z.infer<
  typeof pendingApprovalRequestSchema
>;

/**
 * Spec 9.8: every action tool returns this shape, whatever the policy says.
 * MCP needs an object at the root of an output schema, so the union of
 * `ActionToolOutput` is one object with `outcome` and the fields it implies.
 */
export function actionToolOutputSchema<TResult extends z.ZodType>(
  result: TResult,
) {
  return z
    .object({
      outcome: z.enum(["completed", "approval_required"]),
      result: result.optional(),
      request: pendingApprovalRequestSchema.optional(),
      message: z.string().optional(),
    })
    .strict()
    .superRefine((value, context) => {
      const complete =
        value.outcome === "completed"
          ? value.result !== undefined
          : value.request !== undefined && value.message !== undefined;
      if (!complete) {
        context.addIssue({
          code: "custom",
          message: `Missing the fields of outcome ${value.outcome}.`,
        });
      }
    });
}

export type ActionToolOutput<TResult> =
  | { outcome: "completed"; result: TResult }
  | {
      outcome: "approval_required";
      request: PendingApprovalRequest;
      message: string;
    };
