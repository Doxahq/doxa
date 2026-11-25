import { z } from "zod";

/**
 * The signed-in person's privacy switches. `productAnalytics: false` stops
 * every analytics record about the person, from the API and from each of
 * their browsers. The default is `true`.
 */
export const privacySettingsSchema = z.object({ productAnalytics: z.boolean() }).strict();

export type PrivacySettings = z.infer<typeof privacySettingsSchema>;

export const updatePrivacySettingsInputSchema = z.object({ productAnalytics: z.boolean() }).strict();

export type UpdatePrivacySettingsInput = z.infer<typeof updatePrivacySettingsInputSchema>;
