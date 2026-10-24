import { z } from "zod";

export const EMAIL_DELIVERY_STATUSES = ["queued", "sending", "sent", "failed", "suppressed"] as const;

export const emailDeliveryStatusSchema = z.enum(EMAIL_DELIVERY_STATUSES);

export type EmailDeliveryStatus = z.infer<typeof emailDeliveryStatusSchema>;
