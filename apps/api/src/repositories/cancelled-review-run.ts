import { z } from "zod";

/** The text of a pull request check that ends as cancelled. */
export interface CancelledReviewRunPresentation {
  title: string;
  summary: string;
  /** Shows the "Retry preview" button, for example on a preview that timed out. */
  retryable?: boolean;
}

const cancelEventDataSchema = z.object({
  check: z.object({
    title: z.string().trim().min(1).max(255),
    summary: z.string().trim().min(1).max(60_000),
    retryable: z.boolean().optional(),
  }),
});

/**
 * The cancel event of a preview job keeps the check text of the cancel. A
 * check that GitHub creates during the cancel has no stored ID yet, so the
 * cancel cannot write it. Its creator reads the text from the event instead.
 */
export function withCancelledCheck(
  data: Record<string, unknown> | undefined,
  check: CancelledReviewRunPresentation | undefined,
): Record<string, unknown> | undefined {
  return check ? { ...data, check } : data;
}

/** The check text in the data of a cancel event; null when it has none. */
export function cancelledCheckFromEventData(
  data: unknown,
): CancelledReviewRunPresentation | null {
  const parsed = cancelEventDataSchema.safeParse(data);
  if (!parsed.success) return null;
  const { title, summary, retryable } = parsed.data.check;
  return retryable === undefined ? { title, summary } : { title, summary, retryable };
}
