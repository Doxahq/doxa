import { EMAIL_NOTIFICATION_CATEGORIES } from "@doxahq/email/catalog";
import { z } from "zod";

export { EMAIL_NOTIFICATION_CATEGORIES };

export const emailNotificationCategorySchema = z.enum(EMAIL_NOTIFICATION_CATEGORIES);

export type EmailNotificationCategory = z.infer<typeof emailNotificationCategorySchema>;

/** One switch for each notification category. Invites always send. */
export const emailPreferencesSchema = z
  .object({
    preferences: z.array(
      z.object({ category: emailNotificationCategorySchema, enabled: z.boolean() }).strict(),
    ),
  })
  .strict();

export type EmailPreferences = z.infer<typeof emailPreferencesSchema>;

export const updateEmailPreferenceInputSchema = z
  .object({ category: emailNotificationCategorySchema, enabled: z.boolean() })
  .strict();

export type UpdateEmailPreferenceInput = z.infer<typeof updateEmailPreferenceInputSchema>;

/** The answer of the one-click unsubscribe endpoint. */
export const emailUnsubscribeResultSchema = z
  .object({ category: emailNotificationCategorySchema, unsubscribed: z.literal(true) })
  .strict();

export type EmailUnsubscribeResult = z.infer<typeof emailUnsubscribeResultSchema>;
