import { z } from "zod";

/** Shared prop schemas, so every kind validates names and links the same way. */
export const displayName = z.string().trim().min(1).max(120);

export const emailLink = z.url({ protocol: /^https?$/ });

/** Every notification email carries the one-click unsubscribe link of its recipient. */
export const notificationFields = {
  unsubscribeUrl: emailLink,
};
