import { EmailConfigurationError, requireSetting, type EmailEnv } from "./config";
import { CloudflareEmailTransport } from "./providers/cloudflare/cloudflare-email-transport";
import { LogEmailTransport } from "./providers/log-email-transport";
import type { EmailTransport } from "./transport";

interface EmailProviderDefinition {
  /** Reads the provider's own settings and builds its transport. Throws `EmailConfigurationError`. */
  create(env: EmailEnv): EmailTransport;
}

/**
 * Every provider that Doxa can send through. To add one, write a transport
 * under `providers/<name>/`, add its settings to `EmailEnv`, and add one entry here.
 * To switch providers, change `EMAIL_PROVIDER`. Feature code does not change.
 */
export const EMAIL_PROVIDERS = {
  cloudflare: {
    create: (env) => new CloudflareEmailTransport(requireSetting(env.EMAIL, "the EMAIL send_email binding")),
  },
  log: {
    create: () => new LogEmailTransport(),
  },
} as const satisfies Record<string, EmailProviderDefinition>;

export type EmailProviderName = keyof typeof EMAIL_PROVIDERS;

export function isEmailProviderName(value: string): value is EmailProviderName {
  return Object.hasOwn(EMAIL_PROVIDERS, value);
}

/** Builds the transport that `EMAIL_PROVIDER` names. */
export function createEmailTransport(env: EmailEnv): EmailTransport {
  const name = requireSetting(env.EMAIL_PROVIDER, "EMAIL_PROVIDER").trim();
  if (!isEmailProviderName(name)) {
    const known = Object.keys(EMAIL_PROVIDERS).join(", ");
    throw new EmailConfigurationError(`EMAIL_PROVIDER "${name}" is not known. Use one of: ${known}.`);
  }
  return EMAIL_PROVIDERS[name].create(env);
}
