/**
 * `@doxahq/billing`: types, entitlements, the credit ledger and meter,
 * quotas, founder slots and account resolution. No provider SDK: for
 * the API, the MCP server and the agent worker. Payments live in
 * `@doxahq/billing/payments` (API Node origin only).
 * The Postgres store (`createPostgresBillingStore(db)`) is here too (spec 6.2).
 */
export * from "./catalog/index";
export { DAY_MS, HOUR_MS, MINUTE_MS, startOfUtcDay, systemClock, type Clock } from "./clock";
export { BillingConfigurationError, readBillingConfig, BILLING_ENFORCEMENT_MODES, BILLING_PROVIDER_NAMES, type BillingConfig, type BillingEnforcement, type BillingEnv, type StripeConfig } from "./config";
export {
  BillingInputError,
  BillingNotFoundError,
  BillingStateError,
  BillingUnknownCustomerError,
  CreditsExhaustedError,
  OfferClosedError,
  PlanLimitError,
  RESERVATION_IN_USE,
  type CreditsExhaustedReason,
} from "./errors";

export { createAccountResolver, type AccountResolver, type AccountResolverDeps, type ProjectOwnershipPort } from "./accounts/resolve-account";
export { BillingAccountSettings } from "./accounts/settings";

export {
  creditContextFor,
  hasFeature,
  pastDueGraceEnd,
  resolveEntitlements,
  withinLimit,
  type EntitlementSource,
  type Entitlements,
  type FeatureDenialReason,
  type ResolveEntitlementsInput,
} from "./entitlements/resolve";
export {
  MAX_BRANCHES_PER_SITE_CONTRACT,
  UNLIMITED_NUMBER,
  createEntitlementAdapters,
  toCustomDomainLimit,
  toHostingTier,
  toPlanSearchPolicy,
  toPlanStorageLimits,
  toProjectEntitlements,
  type BillingEntitlementAdapters,
  type ProjectEntitlementsLookup,
} from "./entitlements/adapters";
export { BillingEntitlements, type AccountBillingView } from "./entitlements/service";

export { addMonthsClamped, allowanceSourceRef, allowanceWindow, type AllowanceWindow } from "./credits/allowance";
export { freeCreditContext, type CreditContext } from "./credits/context";
export {
  chargeCredits,
  chargeRuleFor,
  firstHoldCredits,
  MARGIN_SHARE_OF_CAP,
  marginFor,
  markupHundredths,
  meterPricingFor,
  resolveCap,
  runningPrice,
  usageCredits,
  validateCap,
  type MeterPricing,
} from "./credits/pricing";
export {
  CREDITS_LOW_PERCENT,
  NO_BILLING_NOTIFIER,
  PAYG_LIMIT_NOTICE_PERCENTS,
  billingNotificationWindowKey,
  creditNotifications,
  readCreditSnapshot,
  withProjectedDebit,
  type BillingNotification,
  type BillingNotificationKind,
  type BillingNotifier,
  type CreditSnapshot,
  type CreditSnapshotDeps,
  type PaygLimitNoticePercent,
} from "./credits/notifications";
export { ESTIMATE_HISTORY_RUNS, estimateRun, median, type RunEstimate } from "./credits/estimate";
export { CreditLedger, sortForDebit, type Balance, type ExtendResult, type ReserveInput, type ReserveResult, type SettleInput, type SettleResult } from "./credits/ledger";
export {
  CreditMeter,
  type AccrueResult,
  type CreditMeterDeps,
  type MeterEvents,
  type MeterSubject,
  type OpenInput,
  type OpenResult,
  type RunStatus,
  type SubjectCredits,
} from "./credits/meter";
export {
  chargeThresholdCents,
  debtRoom,
  defaultPaygSettings,
  exhaustedReason,
  monthlyLimitCredits,
  paygStatus,
  sweepCredits,
  validateMonthlyLimitCents,
  type DebtRoom,
  type PaygInputs,
  type PaygOffReason,
  type PaygStatus,
} from "./credits/payg";
export { PICO_PER_USD, ceilDiv, formatUsd12, parseUsd, usdNumber, type PicoUsd } from "./credits/usd";
export {
  DOCS_CHAT_ACTION,
  DOCS_CHAT_SUBJECT_KIND,
  createDocsChatBilling,
  type DocsChatBilling,
  type DocsChatOutcome,
  type DocsChatSession,
} from "./credits/docs-chat";

export { CHECKOUT_HOLD_MS, OfferSlots, type HoldResult } from "./offers/founder";
export { UsageQuota, type QuotaResult } from "./quotas/daily-quota";
export {
  EXPORT_WINDOW_LIMIT_KEY,
  EXPORTS_PER_WINDOW,
  ExportQuota,
  exportWindowHours,
  type ExportQuotaReservation,
  type ExportQuotaStatus,
} from "./quotas/export-quota";

// Types only: the API's analytics adapter implements this port; the payments live in `/payments`.
export type { AccountSubscriptionSnapshot, BillingLifecycleEvents, SubscriptionLifecycleChange } from "./lifecycle-events";

export { BillingNotConfiguredError, NOT_TRIALING, PAYMENT_FAILED, ProviderRejectedError, ProviderSignatureError, ProviderUnavailableError } from "./provider/errors";
export * from "./provider/provider";

export { StoreConflictError, type AccountState, type AccountTx, type BillingStore, type EnsureAccountInput, type OfferTx, type ReservationTx } from "./store/store";
export * from "./store/types";
export { PostgresBillingStore, createPostgresBillingStore } from "./store/postgres";
