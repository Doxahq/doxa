import { z } from "zod";

/**
 * Billing API DTOs (billing spec 15.1) and the two denial shapes of spec 9.3.
 *
 * The contracts do not import `@doxahq/billing` (that package depends on the
 * contracts), so plan, feature, limit and action keys are plain strings here.
 * The API checks every key against the catalog: a client never sends an
 * amount, a provider price ID or a plan (spec 17).
 */

const isoDate = z.iso.datetime({ offset: true });

/** A plan price interval. */
export const billingIntervalSchema = z.enum(["month", "year"]);
export type BillingInterval = z.infer<typeof billingIntervalSchema>;

/** A numeric limit, or `"unlimited"`. */
export const billingLimitValueSchema = z.union([z.number().int().nonnegative(), z.literal("unlimited")]);
export type BillingLimitValue = z.infer<typeof billingLimitValueSchema>;

export const billingOwnerKindSchema = z.enum(["user", "team"]);
export type BillingOwnerKind = z.infer<typeof billingOwnerKindSchema>;

/** One row of `GET /billing/accounts`. */
export const billingAccountSummarySchema = z
  .object({
    id: z.string().min(1),
    ownerKind: billingOwnerKindSchema,
    /** The user ID or the team ID. */
    ownerId: z.string().min(1),
    /** The team name, or null for the personal account. */
    name: z.string().nullable(),
    /** The effective plan (entitlements), not a cached plan key. */
    plan: z.string().min(1),
    /** True when the viewer may use Checkout, the Portal and the settings. */
    canManage: z.boolean(),
  })
  .strict();
export type BillingAccountSummary = z.infer<typeof billingAccountSummarySchema>;

/**
 * `BILLING_ENFORCEMENT` of the server (spec 6.3). The dashboard gates AI and
 * limits only when it is `on`; `off` and `shadow` keep today's dashboard. A
 * missing value (an older API) is `off`.
 */
export const billingEnforcementSchema = z.enum(["off", "shadow", "on"]);
export type BillingEnforcementMode = z.infer<typeof billingEnforcementSchema>;

export const billingAccountListSchema = z
  .object({ enforcement: billingEnforcementSchema.default("off"), accounts: z.array(billingAccountSummarySchema) })
  .strict();
export type BillingAccountList = z.infer<typeof billingAccountListSchema>;

export const billingOfferPriceSchema = z
  .object({
    priceKey: z.string().min(1),
    interval: billingIntervalSchema,
    amountCents: z.number().int().nonnegative(),
    monthlyEquivalentCents: z.number().int().nonnegative(),
  })
  .strict();

/** The public view of one offer (spec 7.5): the prices a new Checkout uses now. */
export const billingOfferSchema = z
  .object({
    offerKey: z.string().min(1),
    label: z.string(),
    open: z.boolean(),
    slotsLeft: z.number().int().nonnegative(),
    maxAccounts: z.number().int().nonnegative(),
    prices: z.object({ month: billingOfferPriceSchema, year: billingOfferPriceSchema }).strict(),
    yearlySavingsPercent: z.number().int(),
  })
  .strict();
export type BillingOffer = z.infer<typeof billingOfferSchema>;

/** `GET /billing/offers`: public, cached 60 seconds. */
export const billingOffersSchema = z.object({ offers: z.array(billingOfferSchema) }).strict();
export type BillingOffers = z.infer<typeof billingOffersSchema>;

export const billingCreditsSchema = z
  .object({
    available: z.number().int(),
    /** Credits left in live grants (allowance, trial, promo). */
    granted: z.number().int().nonnegative(),
    /** The monthly allowance of the plan. */
    allowance: billingLimitValueSchema,
    /** The end of the current allowance window. */
    allowanceResetsAt: isoDate,
    held: z.number().int().nonnegative(),
  })
  .strict();

export const billingPaygSchema = z
  .object({
    /** The account setting (`billing_accounts.payg_enabled`). */
    enabled: z.boolean(),
    /** Whether pay-as-you-go applies now (plan, trial, failed payment, dispute, setting). */
    active: z.boolean(),
    offReason: z.string().nullable(),
    /** Open debt in credits. */
    debt: z.number().int().nonnegative(),
    /** Debt on invoices that are not paid yet, in credits. */
    debtInPayment: z.number().int().nonnegative(),
    /** Pay-as-you-go credits in the current allowance window. */
    monthTotal: z.number().int().nonnegative(),
    monthlyLimitCents: z.number().int().nonnegative(),
    monthlyLimitRangeCents: z.tuple([z.number().int(), z.number().int()]),
    /** The amount at which the provider charges the debt, in credits. */
    chargeAtCredits: z.number().int().positive(),
    /**
     * The next monthly sweep of the debt (spec 10.10 step 6): the end of the
     * current allowance window from the billing anchor. Null without an
     * active or past-due paid subscription.
     */
    nextSweepAt: isoDate.nullable(),
    /** True while a threshold or sweep invoice exists and is not paid or failed yet (draft or open): "Charge in progress". */
    thresholdInvoiceOpen: z.boolean(),
  })
  .strict();

export const billingActionCapSchema = z
  .object({
    action: z.string().min(1),
    capCredits: z.number().int().nonnegative(),
    baseCredits: z.number().int().nonnegative(),
    /** The lowest cap that the user can set. */
    minCap: z.number().int().nonnegative(),
    defaultCap: z.number().int().nonnegative(),
    maxCap: z.number().int().nonnegative(),
  })
  .strict();

/**
 * The card that the provider charges: the subscription's default payment
 * method, else the customer's invoice default. Only these four fields.
 */
export const billingPaymentMethodSchema = z
  .object({
    /** The card network, such as `visa`, `mastercard` or `amex`. */
    brand: z.string().min(1),
    last4: z.string().min(1).max(4),
    expMonth: z.number().int().min(1).max(12),
    expYear: z.number().int(),
  })
  .strict();
export type BillingPaymentMethod = z.infer<typeof billingPaymentMethodSchema>;

/** `GET /billing/accounts/:accountId`. */
export const billingAccountDetailSchema = z
  .object({
    id: z.string().min(1),
    ownerKind: billingOwnerKindSchema,
    ownerId: z.string().nullable(),
    /** The team name, or null for the personal account (as in `GET /billing/accounts`). */
    name: z.string().nullable(),
    plan: z.string().min(1),
    planSource: z.enum(["subscription", "override", "default"]),
    /** The provider the account bills through (`stripe`, `memory`, `none`). */
    provider: z.string().min(1),
    canManage: z.boolean(),
    /**
     * Whether a new Checkout comes with the Pro trial: only for an account that
     * never had a subscription (the trial rule of `createCheckout`).
     */
    trialAvailable: z.boolean(),
    subscription: z
      .object({
        status: z.string().min(1),
        priceKey: z.string().min(1),
        currentPeriodStart: isoDate,
        currentPeriodEnd: isoDate,
        /** The date the subscription ends when it is canceled at period end. */
        cancelAt: isoDate.nullable(),
        trialEnd: isoDate.nullable(),
        inGracePeriod: z.boolean(),
      })
      .strict()
      .nullable(),
    entitlements: z
      .object({
        hosting: z.enum(["shared", "dedicated"]),
        features: z.record(z.string(), z.boolean()),
        limits: z.record(z.string(), billingLimitValueSchema),
      })
      .strict(),
    credits: billingCreditsSchema,
    payg: billingPaygSchema,
    caps: z.array(billingActionCapSchema),
    aiPausedReason: z.string().nullable(),
    /** The offers this account can buy now: empty while it has a live subscription. */
    offers: z.array(billingOfferSchema),
    /**
     * The card on file, read from the provider on each detail read (one call).
     * Null when there is none, when it is not a card (for example Link with
     * Managed Payments), where payments are not available (a Worker build,
     * provider `none`), or when the provider read failed. The API always
     * sends it.
     */
    paymentMethod: billingPaymentMethodSchema.nullable(),
  })
  .strict();
export type BillingAccountDetail = z.infer<typeof billingAccountDetailSchema>;

export const billingLedgerEntrySchema = z
  .object({
    id: z.string().min(1),
    kind: z.string().min(1),
    credits: z.number().int(),
    actionKey: z.string().nullable(),
    subjectKind: z.string().nullable(),
    subjectId: z.string().nullable(),
    createdAt: isoDate,
  })
  .strict();
export type BillingLedgerEntry = z.infer<typeof billingLedgerEntrySchema>;

/** `GET /billing/accounts/:accountId/credits/entries`, newest first. */
export const billingLedgerPageSchema = z
  .object({ entries: z.array(billingLedgerEntrySchema), nextCursor: z.string().nullable() })
  .strict();
export type BillingLedgerPage = z.infer<typeof billingLedgerPageSchema>;

export const billingInvoiceSchema = z
  .object({
    invoiceId: z.string().min(1),
    status: z.string().min(1),
    reason: z.string().min(1),
    amountDueCents: z.number().int(),
    amountPaidCents: z.number().int(),
    currency: z.literal("usd"),
    usageCredits: z.number().int().nonnegative(),
    createdAt: isoDate,
    hostedInvoiceUrl: z.string().nullable(),
    pdfUrl: z.string().nullable(),
  })
  .strict();
export type BillingInvoice = z.infer<typeof billingInvoiceSchema>;

/** `GET /billing/accounts/:accountId/invoices`. */
export const billingInvoicePageSchema = z
  .object({ invoices: z.array(billingInvoiceSchema), nextCursor: z.string().nullable() })
  .strict();
export type BillingInvoicePage = z.infer<typeof billingInvoicePageSchema>;

/** The query of the two paged reads. */
export const billingPageQuerySchema = z
  .object({
    limit: z.coerce.number().int().min(1).max(100).default(25),
    cursor: z.string().min(1).max(512).optional(),
  })
  .strict();

/** The longest `returnPath` that Checkout accepts. */
export const CHECKOUT_RETURN_PATH_MAX_LENGTH = 512;
/** Every `returnPath` starts with this prefix. */
export const CHECKOUT_RETURN_PATH_PREFIX = "/dashboard/";
// No C0 controls, no DEL, no C1 controls.
const CONTROL_CHARACTERS = /[\u0000-\u001f\u007f-\u009f]/;
const CHECK_BASE = "https://return-path.invalid";

/**
 * Why `returnPath` is not a dashboard path that Checkout may return to, or
 * null when it is one (billing spec 17: no open redirect). The path is
 * relative, starts with `/dashboard/`, has no `//`, no `\`, no control
 * character and at most 512 characters, and still resolves on `base` (the
 * dashboard origin) to a path under `/dashboard/` (so `..` and `%2e%2e` cannot
 * leave it). A full URL is never accepted.
 */
export function checkoutReturnPathProblem(returnPath: string, base: string = CHECK_BASE): string | null {
  if (returnPath.length === 0 || returnPath.length > CHECKOUT_RETURN_PATH_MAX_LENGTH) {
    return `The return path must have 1 to ${CHECKOUT_RETURN_PATH_MAX_LENGTH} characters.`;
  }
  if (!returnPath.startsWith(CHECKOUT_RETURN_PATH_PREFIX)) return "The return path must start with /dashboard/.";
  if (returnPath.includes("//")) return "The return path must not contain //.";
  if (returnPath.includes("\\")) return "The return path must not contain a backslash.";
  if (CONTROL_CHARACTERS.test(returnPath)) return "The return path must not contain control characters.";
  let origin: string;
  let resolved: URL;
  try {
    origin = new URL(base).origin;
    resolved = new URL(returnPath, base);
  } catch {
    return "The return path is not a valid path.";
  }
  if (resolved.origin !== origin) return "The return path must stay on the dashboard origin.";
  if (!resolved.pathname.startsWith(CHECKOUT_RETURN_PATH_PREFIX)) return "The return path must stay under /dashboard/.";
  return null;
}

/** A relative dashboard path, checked by `checkoutReturnPathProblem`. */
export const checkoutReturnPathSchema = z
  .string()
  .max(CHECKOUT_RETURN_PATH_MAX_LENGTH)
  .superRefine((value, context) => {
    const problem = checkoutReturnPathProblem(value);
    if (problem) context.addIssue({ code: "custom", message: problem });
  });

/**
 * `POST /billing/accounts/:accountId/checkout`: `{ offer }` is a catalog price
 * key the customer saw. `returnPath` is an optional dashboard path (such as
 * `/dashboard/projects/new?start=repository`) that Checkout returns to in place
 * of the billing page.
 */
export const billingCheckoutInputSchema = z
  .object({ offer: z.string().trim().min(1).max(100), returnPath: checkoutReturnPathSchema.optional() })
  .strict();
export type BillingCheckoutInput = z.infer<typeof billingCheckoutInputSchema>;

/** `POST /billing/accounts/:accountId/portal`. */
export const billingPortalInputSchema = z
  .object({ flow: z.enum(["payment_method_update", "subscription_cancel"]).optional() })
  .strict();
export type BillingPortalInput = z.infer<typeof billingPortalInputSchema>;

/** The answer of the checkout and portal routes. */
export const billingRedirectSchema = z.object({ url: z.url() }).strict();
export type BillingRedirect = z.infer<typeof billingRedirectSchema>;

/**
 * `PUT /billing/accounts/:accountId/payg`. The range of `monthlyLimitCents`
 * (500 to 20,000) is the catalog's: the API answers 400 outside it.
 */
export const billingPaygInputSchema = z
  .object({
    enabled: z.boolean().optional(),
    monthlyLimitCents: z.number().int().optional(),
  })
  .strict()
  .refine((value) => value.enabled !== undefined || value.monthlyLimitCents !== undefined, {
    message: "Send enabled, monthlyLimitCents or both.",
  });
export type BillingPaygInput = z.infer<typeof billingPaygInputSchema>;

/** `POST /billing/accounts/:accountId/plan-interval`: the monthly/yearly switch. */
export const billingPlanIntervalInputSchema = z.object({ interval: billingIntervalSchema }).strict();
export type BillingPlanIntervalInput = z.infer<typeof billingPlanIntervalInputSchema>;

/** The answer of the plan-interval route: the price key the subscription is on now. */
export const billingPlanIntervalResultSchema = z.object({ priceKey: z.string().min(1) }).strict();
export type BillingPlanIntervalResult = z.infer<typeof billingPlanIntervalResultSchema>;

/** The query of `GET /billing/accounts/:accountId/plan-interval/preview`. */
export const billingPlanIntervalPreviewQuerySchema = z.object({ interval: billingIntervalSchema }).strict();
export type BillingPlanIntervalPreviewQuery = z.infer<typeof billingPlanIntervalPreviewQuerySchema>;

/**
 * `GET /billing/accounts/:accountId/plan-interval/preview?interval=`: what the
 * switch of `POST .../plan-interval` charges now (the provider's invoice
 * preview of the same items and proration). All amounts are USD cents, 0 or more.
 */
export const billingPlanIntervalPreviewSchema = z
  .object({
    /** What the card is charged now, after any credit the customer already has. */
    chargeTodayCents: z.number().int().nonnegative(),
    /** The credit for the unused time of the current price. */
    creditCents: z.number().int().nonnegative(),
    /** The full price of the new interval (the founder price for a founder). */
    newPriceCents: z.number().int().nonnegative(),
    newInterval: billingIntervalSchema,
    /** The credit left on the account for later invoices after the switch. */
    balanceAfterCents: z.number().int().nonnegative(),
  })
  .strict();
export type BillingPlanIntervalPreview = z.infer<typeof billingPlanIntervalPreviewSchema>;

/**
 * `GET /billing/accounts/:accountId/start-pro-now`: what Start Pro now
 * (decision D22) charges today, for the confirm dialog. `intervalLabel` is
 * the billing interval of the plan price: "$159 / month".
 */
export const billingStartProNowPreviewSchema = z
  .object({
    amountCents: z.number().int().nonnegative(),
    currency: z.literal("usd"),
    intervalLabel: billingIntervalSchema,
  })
  .strict();
export type BillingStartProNowPreview = z.infer<typeof billingStartProNowPreviewSchema>;

/** `PUT /billing/accounts/:accountId/caps`. Each value from `minCap` up to `maxCap`. */
export const billingCapInputSchema = z
  .object({ action: z.string().trim().min(1).max(64), capCredits: z.number().int() })
  .strict();
export type BillingCapInput = z.infer<typeof billingCapInputSchema>;

/** `GET /projects/:projectId/credit-estimate?action=`: "About low–high credits. Stops at cap." */
export const creditEstimateSchema = z
  .object({
    action: z.string().min(1),
    low: z.number().int().nonnegative(),
    high: z.number().int().nonnegative(),
    cap: z.number().int().nonnegative(),
    source: z.enum(["history", "default"]),
  })
  .strict();
export type CreditEstimate = z.infer<typeof creditEstimateSchema>;

/** `GET /projects/:projectId` adds this, so the shell can show limits without a second request. */
export const projectBillingSchema = z
  .object({ accountId: z.string().min(1), plan: z.string().min(1), enforcement: billingEnforcementSchema.default("off") })
  .strict();
export type ProjectBilling = z.infer<typeof projectBillingSchema>;

/** `error.details` of an HTTP 403 `plan_limit` answer (spec 9.3). */
export const planLimitErrorDetailsSchema = z
  .object({
    code: z.literal("plan_limit"),
    key: z.string().min(1),
    limit: z.union([z.number(), z.literal("unlimited"), z.boolean()]),
    used: z.number().nullable(),
    plan: z.string().nullable(),
    resetsAt: isoDate.nullable(),
    /** Where the user upgrades or manages billing. */
    upgradeUrl: z.string().nullable(),
  })
  .strict();
export type PlanLimitErrorDetails = z.infer<typeof planLimitErrorDetailsSchema>;

/** `error.details` of an HTTP 402 `credits_exhausted` answer (spec 9.3, 10.6). */
export const creditsExhaustedErrorDetailsSchema = z
  .object({
    code: z.literal("credits_exhausted"),
    accountId: z.string().min(1),
    available: z.number().int(),
    needed: z.number().int(),
    reason: z.enum(["trial_credits", "max_debt", "monthly_limit", "past_due", "payg_off"]),
    resetsAt: isoDate.nullable(),
    billingUrl: z.string().nullable(),
  })
  .strict();
export type CreditsExhaustedErrorDetails = z.infer<typeof creditsExhaustedErrorDetailsSchema>;

/**
 * `error.details` of an HTTP 403 `ai_paused_for_review` answer (billing spec
 * 19): the account passed the daily model cost guard. Credits are not
 * touched; AI admission opens again at `resetsAt` or after an operator review.
 */
export const aiPausedForReviewErrorDetailsSchema = z
  .object({
    code: z.literal("ai_paused_for_review"),
    accountId: z.string().min(1),
    resetsAt: isoDate.nullable(),
  })
  .strict();
export type AiPausedForReviewErrorDetails = z.infer<typeof aiPausedForReviewErrorDetailsSchema>;

/**
 * `error.details` of an HTTP 503 `model_unpriced` answer (billing spec 10.5
 * step 7): a model of the run has no price, so the meter could not charge it.
 */
export const modelUnpricedErrorDetailsSchema = z
  .object({
    code: z.literal("model_unpriced"),
    models: z.array(z.string().min(1)),
  })
  .strict();
export type ModelUnpricedErrorDetails = z.infer<typeof modelUnpricedErrorDetailsSchema>;

/** The job event type of the live credit meter (billing spec 10.5, "What the customer sees"). */
export const GENERATION_CREDITS_EVENT_TYPE = "credits";

/** At most one `credits` job event for each job in this window. */
export const GENERATION_CREDITS_EVENT_INTERVAL_MS = 5_000;

/**
 * `data` of a `credits` job event, which the generation event stream
 * (`GET /projects/:projectId/generations/:generationId/stream`) carries to
 * the agent activity panel. With `BILLING_ENFORCEMENT=shadow` the numbers
 * are computed and nothing is held (`shadow: true`); with `off` no event is sent.
 */
export const generationCreditsEventDataSchema = z
  .object({
    /**
     * The running price of the current try: base fee + metered usage, never
     * above the cap. A continued run starts a new try, with no base fee.
     */
    usedCredits: z.number().int().nonnegative(),
    /**
     * The credits of the whole job: the earlier tries of a continued run plus
     * this one. It only goes up. Absent on events written before it existed:
     * read `usedCredits` then.
     */
    jobUsedCredits: z.number().int().nonnegative().optional(),
    /** The credits held for the current try now. */
    holdCredits: z.number().int().nonnegative(),
    /** The cap of the current try. */
    capCredits: z.number().int().nonnegative(),
    /** The part of the job's credits above the account's grants, which pay-as-you-go pays. */
    fromPaygCredits: z.number().int().nonnegative(),
    shadow: z.boolean(),
  })
  .strict();
export type GenerationCreditsEventData = z.infer<typeof generationCreditsEventDataSchema>;

/** The job event type of a run that ended as `stopped_credits` (billing spec 10.6). */
export const GENERATION_CREDITS_STOPPED_EVENT_TYPE = "credits_stopped";

/**
 * Why a run ended as `stopped_credits`: a meter stop while it ran
 * (`credits_exhausted`, `credit_cap`), or the code of a billing refusal at
 * admission (a Doxabot preview keeps its job).
 */
export const generationCreditStopReasonSchema = z.enum([
  "credits_exhausted",
  "credit_cap",
  "plan_limit",
  "model_unpriced",
  "ai_paused_for_review",
]);
export type GenerationCreditStopReason = z.infer<typeof generationCreditStopReasonSchema>;

/**
 * `data` of a `credits_stopped` job event, as the generation log and its
 * stream show it: the reason, and the pages that the run finished before it
 * stopped (when known). The stored event has more fields; the log drops them.
 */
export const generationCreditsStoppedEventDataSchema = z.object({
  reason: generationCreditStopReasonSchema,
  finishedPageCount: z.number().int().nonnegative().optional(),
});
export type GenerationCreditsStoppedEventData = z.infer<typeof generationCreditsStoppedEventDataSchema>;
