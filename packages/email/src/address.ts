import { z } from "zod";

/** A mailbox. Each provider adapter converts it to the provider's own shape. */
export interface EmailAddress {
  readonly address: string;
  readonly name?: string;
}

/** Characters that would break a display name or inject a header line. */
const UNSAFE_NAME_PATTERN = /[\r\n<>"]/;

export const emailAddressSchema = z.object({
  address: z.email(),
  name: z
    .string()
    .trim()
    .min(1)
    .max(120)
    .refine((name) => !UNSAFE_NAME_PATTERN.test(name), "The display name has characters that are not allowed.")
    .optional(),
});

/** `Name <address>`, `"Name" <address>`, or a bare address. */
const MAILBOX_PATTERN = /^\s*(?:"?([^"<>]*?)"?\s*<([^<>\s]+)>|([^<>\s]+))\s*$/;

/**
 * Reads one mailbox from configuration, for example
 * `EMAIL_FROM_NOTIFICATIONS="Doxa <no-reply@notification.doxa.so>"`. Throws when the value is not one valid mailbox.
 */
export function parseEmailAddress(value: string): EmailAddress {
  const match = MAILBOX_PATTERN.exec(value);
  const name = match?.[1]?.trim();
  const parsed = emailAddressSchema.safeParse({
    address: match?.[2] ?? match?.[3],
    ...(name ? { name } : {}),
  });
  if (!parsed.success) throw new Error(`"${value}" is not one valid email address.`);
  return parsed.data;
}
