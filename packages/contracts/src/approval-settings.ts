import { z } from "zod";
import { agentActionKindSchema } from "./approval-requests";

/** How an agent action runs: at once, after a person approves, or never. */
export const APPROVAL_MODES = ["allow", "require_approval", "deny"] as const;

export const approvalModeSchema = z.enum(APPROVAL_MODES);

export type ApprovalMode = z.infer<typeof approvalModeSchema>;

/**
 * Why a gate applied, in precedence order. Stored on each approval request
 * as `policySource`.
 */
export const APPROVAL_POLICY_SOURCES = [
  "platform_override",
  "project_setting",
  "user_setting",
  "action_default",
] as const;

export const approvalPolicySourceSchema = z.enum(APPROVAL_POLICY_SOURCES);

export type ApprovalPolicySourceName = z.infer<typeof approvalPolicySourceSchema>;

export const approvalActionSettingSchema = z
  .object({
    actionKind: agentActionKindSchema,
    /** "Publish a branch" */
    title: z.string(),
    /** The only modes a setting can pick. `project.delete` never offers `allow`. */
    allowedModes: z.array(approvalModeSchema).min(1),
    defaultMode: approvalModeSchema,
    /** The stored mode of this scope, or null when it is not set. */
    mode: approvalModeSchema.nullable(),
    /** The mode a new request from the viewer's agents gets today. */
    effectiveMode: approvalModeSchema,
    effectiveSource: approvalPolicySourceSchema,
  })
  .strict();

export type ApprovalActionSetting = z.infer<typeof approvalActionSettingSchema>;

export const projectApprovalSettingsSchema = z
  .object({
    projectId: z.uuid(),
    /** False when the viewer lacks `approvals.configure`: the page is read only. */
    canConfigure: z.boolean(),
    actions: z.array(approvalActionSettingSchema),
    /** The default of the erase checkbox when a person approves a publish. */
    eraseBranchAfterPublish: z.boolean(),
    /**
     * v2 spec §12 question 2: when true, a member cannot approve a request
     * that their own agent made. They can still reject or cancel it.
     */
    requireOtherDecider: z.boolean(),
  })
  .strict();

export type ProjectApprovalSettings = z.infer<typeof projectApprovalSettingsSchema>;

export const userApprovalSettingsSchema = z
  .object({ actions: z.array(approvalActionSettingSchema) })
  .strict();

export type UserApprovalSettings = z.infer<typeof userApprovalSettingsSchema>;

/** Only the changed actions. Null clears the setting of that action. */
export const approvalModeChangesSchema = z.partialRecord(
  agentActionKindSchema,
  approvalModeSchema.nullable(),
);

export type ApprovalModeChanges = z.infer<typeof approvalModeChangesSchema>;

export const updateProjectApprovalSettingsInputSchema = z
  .object({
    modes: approvalModeChangesSchema.optional(),
    eraseBranchAfterPublish: z.boolean().optional(),
    requireOtherDecider: z.boolean().optional(),
  })
  .strict();

export type UpdateProjectApprovalSettingsInput = z.infer<
  typeof updateProjectApprovalSettingsInputSchema
>;

export const updateUserApprovalSettingsInputSchema = z
  .object({ modes: approvalModeChangesSchema.optional() })
  .strict();

export type UpdateUserApprovalSettingsInput = z.infer<
  typeof updateUserApprovalSettingsInputSchema
>;
