/**
 * The provider side, with no React: message, transports, provider registry
 * and configuration. Templates and the mailer live in `@doxahq/email/mailer`;
 * email kinds live in `@doxahq/email/catalog`.
 */
export { emailAddressSchema, parseEmailAddress, type EmailAddress } from "./address";
export {
  EmailConfigurationError,
  readSenders,
  type EmailEnv,
  type EmailSenders,
  type SenderDefaults,
} from "./config";
export { EMAIL_MESSAGE_LIMITS, findEmailMessageProblem, type EmailMessage } from "./message";
export {
  EMAIL_PROVIDERS,
  createEmailTransport,
  isEmailProviderName,
  type EmailProviderName,
} from "./provider-registry";
export {
  CLOUDFLARE_PROVIDER,
  CloudflareEmailTransport,
  type CloudflareEmailBuilder,
  type CloudflareSendEmailBinding,
} from "./providers/cloudflare/cloudflare-email-transport";
export { LOG_PROVIDER, LogEmailTransport, type LogEmailTransportOptions } from "./providers/log-email-transport";
export {
  emailFailed,
  emailSent,
  type EmailFailure,
  type EmailFailureKind,
  type EmailSent,
  type SendEmailResult,
} from "./send-result";
export type { EmailTransport } from "./transport";
export {
  DELIVERY_RETRY_RULES,
  decideDelivery,
  type DeliveryDecision,
  type FinalDeliveryStatus,
} from "./delivery/delivery-policy";
export {
  UnsubscribeTokens,
  readUnsubscribeQuery,
  unsubscribeHeaders,
  type UnsubscribeTarget,
} from "./unsubscribe/unsubscribe-tokens";
export type {
  ClaimedEmailDelivery,
  EmailAttempt,
  EmailAttemptOutcome,
  EmailDeliveryRpc,
  EmailQueueMessage,
} from "./delivery/delivery-rpc";
export type {
  EmailSuppressionSource,
  ProviderSuppression,
  SuppressionPage,
  SuppressionReason,
} from "./suppressions/suppression-source";
export {
  CloudflareSuppressionSource,
  type CloudflareSuppressionSourceOptions,
} from "./providers/cloudflare/cloudflare-suppression-source";
