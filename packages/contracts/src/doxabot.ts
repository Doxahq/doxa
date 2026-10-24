import { z } from "zod";
import { repositoryVisibilitySchema } from "./source-control";

export const doxabotUnavailableReasonSchema = z.enum([
  "global_disabled",
  "initial_generation_required",
  "public_repository_disabled",
  "repository_not_connected",
]);

const availableDoxabotEligibilitySchema = z.object({
  available: z.literal(true),
  enabled: z.boolean(),
  reason: z.null(),
}).strict();

const unavailableDoxabotEligibilitySchema = z.object({
  available: z.literal(false),
  enabled: z.literal(false),
  reason: doxabotUnavailableReasonSchema,
}).strict();

export const doxabotEligibilitySchema = z.discriminatedUnion("available", [
  availableDoxabotEligibilitySchema,
  unavailableDoxabotEligibilitySchema,
]);

/**
 * What a merge into the default branch starts: `manual` lists the merged
 * pull requests, `batched` runs once merges stop for the quiet time, and
 * `every_merge` runs after each merge. Every run goes to a review.
 */
export const doxabotMergeTriggerSchema = z.enum([
  "manual",
  "batched",
  "every_merge",
]);

/** The quiet times that a batched trigger waits after the last merge. */
export const DOXABOT_BATCH_QUIET_MINUTES = [15, 30, 60, 360] as const;

export const doxabotBatchQuietMinutesSchema = z.union([
  z.literal(15),
  z.literal(30),
  z.literal(60),
  z.literal(360),
]);

const doxabotSettingsBaseSchema = z.object({
  enabled: z.boolean(),
  mergeTrigger: doxabotMergeTriggerSchema,
  batchQuietMinutes: doxabotBatchQuietMinutesSchema,
  repositoryVisibility: repositoryVisibilitySchema.nullable(),
  updatedAt: z.string().datetime().nullable(),
});

export const doxabotSettingsSchema = z.discriminatedUnion("available", [
  doxabotSettingsBaseSchema.extend({
    available: z.literal(true),
    unavailableReason: z.null(),
  }).strict(),
  doxabotSettingsBaseSchema.extend({
    available: z.literal(false),
    unavailableReason: doxabotUnavailableReasonSchema,
  }).strict(),
]);

/**
 * A partial update: the client sends only the fields it changes, so a later
 * setting does not break a client that does not know it.
 */
export const updateDoxabotSettingsInputSchema = z
  .object({
    enabled: z.boolean().optional(),
    mergeTrigger: doxabotMergeTriggerSchema.optional(),
    batchQuietMinutes: doxabotBatchQuietMinutesSchema.optional(),
  })
  .strict()
  .refine((input) => Object.keys(input).length > 0, {
    message: "The update changes no setting.",
  });

/** Pull requests merged since the last production generation started. */
export const pendingMergesSchema = z
  .object({
    merges: z.array(
      z
        .object({
          number: z.number().int().positive(),
          mergedAt: z.string().datetime(),
        })
        .strict(),
    ),
  })
  .strict();

export type DoxabotUnavailableReason = z.infer<
  typeof doxabotUnavailableReasonSchema
>;
export type DoxabotEligibility = z.infer<typeof doxabotEligibilitySchema>;
export type DoxabotSettingsDto = z.infer<typeof doxabotSettingsSchema>;
export type UpdateDoxabotSettingsInput = z.infer<
  typeof updateDoxabotSettingsInputSchema
>;
export type DoxabotMergeTrigger = z.infer<typeof doxabotMergeTriggerSchema>;
export type DoxabotBatchQuietMinutes = z.infer<
  typeof doxabotBatchQuietMinutesSchema
>;
export type PendingMerges = z.infer<typeof pendingMergesSchema>;
