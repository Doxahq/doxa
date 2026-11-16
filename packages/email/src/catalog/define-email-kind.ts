import type { z } from "zod";

/** Notification categories. A user can turn each one off. */
export const EMAIL_NOTIFICATION_CATEGORIES = ["approvals", "generations", "domains"] as const;

export type EmailNotificationCategory = (typeof EMAIL_NOTIFICATION_CATEGORIES)[number];

/**
 * `transactional` emails (invites) always send and have no unsubscribe link.
 * `billing` emails (credits and pay-as-you-go, billing spec 10.7) are account
 * notices about money: they also always send, but from the notifications stream.
 */
export type EmailCategory = "transactional" | "billing" | EmailNotificationCategory;

/**
 * The contract of one kind of email: a stable name, a category, and the schema
 * of its props. It has no React, so any Worker can import it to queue an email
 * without loading the renderer.
 */
export interface EmailKind<Name extends string = string, Schema extends z.ZodType = z.ZodType> {
  /** A stable kebab-case name, such as `team-invite`. Stored with each delivery. */
  readonly name: Name;
  readonly category: EmailCategory;
  readonly props: Schema;
}

export type EmailKindProps<Kind extends EmailKind> = z.output<Kind["props"]>;

export function defineEmailKind<const Name extends string, Schema extends z.ZodType>(
  kind: EmailKind<Name, Schema>,
): EmailKind<Name, Schema> {
  return kind;
}

export function isNotificationCategory(category: EmailCategory): category is EmailNotificationCategory {
  return category !== "transactional" && category !== "billing";
}

/**
 * A sending stream: a group of emails with its own sender address on its own
 * subdomain. A blocklist or a bad reputation on one subdomain then stays away
 * from the others. To add a stream, add it here, map its categories in
 * `streamOf`, and add its sender setting in `config.ts`.
 */
export const EMAIL_STREAMS = ["transactional", "notifications"] as const;

export type EmailStream = (typeof EMAIL_STREAMS)[number];

export function streamOf(category: EmailCategory): EmailStream {
  // `billing` goes with the notifications, so the invite subdomain keeps its own reputation.
  return category === "transactional" ? "transactional" : "notifications";
}
