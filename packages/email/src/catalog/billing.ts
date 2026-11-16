import { z } from "zod";
import { defineEmailKind, type EmailKindProps } from "./define-email-kind";
import { displayName, emailLink } from "./fields";

/**
 * Billing notices (billing spec 10.7). Each one states one fact and links to
 * the billing page of the account. They never offer a "Pay now" link
 * (decision D19): Doxa charges the card automatically.
 */
const billingFields = {
  /** The team name, or absent for a personal account. */
  teamName: displayName.optional(),
  billingUrl: emailLink,
};

/** A short amount for people, such as `$30` or `$12.40`. */
const usdAmount = z.string().trim().regex(/^\$\d{1,6}(\.\d{2})?$/);

/** A date for people, such as `December 1, 2026`. */
const shortDate = z.string().trim().min(1).max(40);

const credits = z.number().int().nonnegative();

/** 80% of the monthly allowance is used. */
export const creditsLowEmail = defineEmailKind({
  name: "credits-low",
  category: "billing",
  props: z.object({
    ...billingFields,
    usedCredits: credits,
    allowanceCredits: z.number().int().positive(),
    resetsOn: shortDate,
    /** True when runs continue on pay-as-you-go after the allowance. */
    paygOn: z.boolean(),
  }),
});

/** The allowance is used up and pay-as-you-go started. */
export const paygStartedEmail = defineEmailKind({
  name: "payg-started",
  category: "billing",
  props: z.object({
    ...billingFields,
    chargeAtUsd: usdAmount,
    monthlyLimitUsd: usdAmount,
    resetsOn: shortDate,
  }),
});

export const PAYG_LIMIT_PERCENTS = [50, 80, 100] as const;

/** 50%, 80% or 100% of the monthly pay-as-you-go limit is used. */
export const paygLimitEmail = defineEmailKind({
  name: "payg-limit",
  category: "billing",
  props: z.object({
    ...billingFields,
    percent: z.union([z.literal(50), z.literal(80), z.literal(100)]),
    spentUsd: usdAmount,
    monthlyLimitUsd: usdAmount,
    chargeAtUsd: usdAmount,
    resetsOn: shortDate,
  }),
});

/** The trial credits are used up. */
export const creditsExhaustedEmail = defineEmailKind({
  name: "credits-exhausted",
  category: "billing",
  props: z.object({
    ...billingFields,
    trialCredits: z.number().int().positive().optional(),
  }),
});

export type CreditsLowEmailProps = EmailKindProps<typeof creditsLowEmail>;
export type PaygStartedEmailProps = EmailKindProps<typeof paygStartedEmail>;
export type PaygLimitEmailProps = EmailKindProps<typeof paygLimitEmail>;
export type CreditsExhaustedEmailProps = EmailKindProps<typeof creditsExhaustedEmail>;
export type PaygLimitPercent = PaygLimitEmailProps["percent"];
