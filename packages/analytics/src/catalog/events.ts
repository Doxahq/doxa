import { browserEvent, serverEvent, type ProductEventDefinition } from "./define-event";
import {
  actionVia,
  amountCents,
  billingInterval,
  branchKind,
  clientLabel,
  codeToken,
  count,
  durationSeconds,
  flag,
  generationOutcome,
  generationRun,
  generationTrigger,
  invoiceKind,
  pageSaveVia,
  planTier,
  projectSource,
  publishVia,
  signInMethod,
  teamRole,
} from "./property-schemas";

/**
 * Every product event that Doxa sends to analytics. An event that is not in
 * this list cannot be sent. Names are `object_action`, in snake case and the
 * past tense. Never add a property that can hold customer content: code, file
 * paths, repository or branch names, docs text, prompts, tokens or emails.
 */
export const PRODUCT_EVENTS = {
  // Visit and sign-up.
  /** A call-to-action button on doxa.so, such as Get started. */
  cta_clicked: browserEvent({ location: codeToken, cta: codeToken, plan: planTier.optional() }),
  /** The sign-up form was sent. The account may still fail to be created. */
  signup_form_submitted: browserEvent({ method: signInMethod }),
  /** A new user row was created. */
  user_signed_up: serverEvent({ method: signInMethod }),
  /** An email verification link was used. */
  email_verified: serverEvent({}),
  /** A session was created. */
  user_signed_in: serverEvent({ method: signInMethod }),

  // Activation.
  /** The Doxa GitHub App was installed or given new repositories. */
  github_app_installed: serverEvent({ repo_count: count }),
  project_created: serverEvent({ source: projectSource, via: actionVia }),
  /** A generation job was queued. */
  generation_started: serverEvent({
    trigger: generationTrigger,
    run: generationRun,
    via: actionVia.optional(),
    credit_estimate: count.optional(),
  }),
  /** A generation job reached an end state. */
  generation_finished: serverEvent({
    trigger: generationTrigger,
    outcome: generationOutcome,
    duration_s: durationSeconds,
    pages_written: count.optional(),
    credits_used: count.optional(),
    error_code: codeToken.optional(),
  }),
  /** A branch was published to the live site. */
  docs_published: serverEvent({ first_publish: flag, via: publishVia }),
  /** A page was written, from any surface. */
  docs_page_saved: serverEvent({ via: pageSaveVia, branch_kind: branchKind }),
  /** A custom domain passed its DNS check. */
  custom_domain_verified: serverEvent({ dns_host: codeToken.optional() }),
  /** A person approved an agent in the OAuth consent screen. */
  mcp_agent_connected: serverEvent({ client: clientLabel, scope_count: count }),
  /** A Doxabot pull request run reached an end state. */
  doxabot_run_finished: serverEvent({
    outcome: generationOutcome,
    credits_used: count.optional(),
    pages_changed: count.optional(),
  }),

  // Teams.
  team_created: serverEvent({}),
  /** Never carries the invitee's email. */
  team_invite_sent: serverEvent({ role: teamRole }),
  team_invite_accepted: serverEvent({ role: teamRole }),

  // Upgrade.
  /** A Pro action opened the Pro trial dialog. */
  pro_trial_dialog_opened: browserEvent({ feature: codeToken }),
  /** An Upgrade or Start Pro now button was clicked. */
  upgrade_clicked: browserEvent({ location: codeToken, interval: billingInterval.optional() }),
  /** A plan limit refused an action (a 402 or a 403 plan-limit answer). */
  plan_limit_hit: serverEvent({ limit: codeToken, plan: codeToken }),
  /** A Checkout Session was created. */
  checkout_started: serverEvent({
    plan_key: codeToken,
    interval: billingInterval,
    trial: flag,
    founder: flag,
  }),
  checkout_completed: serverEvent({ plan_key: codeToken.optional(), interval: billingInterval.optional() }),
  checkout_expired: serverEvent({}),

  // Paid.
  /** The subscription mirror moved to `trialing`. */
  trial_started: serverEvent({ plan_key: codeToken, interval: billingInterval, founder: flag }),
  /** The subscription mirror moved from `trialing` to `active`. */
  trial_converted: serverEvent({
    plan_key: codeToken,
    interval: billingInterval,
    days_in_trial: count,
    credits_used_in_trial: count.optional(),
  }),
  /** The subscription mirror moved to `active` without a trial. */
  subscription_started: serverEvent({ plan_key: codeToken, interval: billingInterval, founder: flag }),
  invoice_paid: serverEvent({ kind: invoiceKind, amount_cents: amountCents, attempt: count.optional() }),
  invoice_payment_failed: serverEvent({ kind: invoiceKind, amount_cents: amountCents, attempt: count.optional() }),
  /** The subscription mirror moved to `past_due`. */
  subscription_past_due: serverEvent({ days_overdue: count.optional() }),
  subscription_interval_changed: serverEvent({ from: billingInterval, to: billingInterval }),
  /** The subscription mirror moved to `canceled`. */
  subscription_canceled: serverEvent({ was_trial: flag, months_paid: count.optional() }),
} as const satisfies Record<string, ProductEventDefinition>;
