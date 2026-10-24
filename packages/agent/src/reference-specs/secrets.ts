/**
 * What a redacted value shows instead. It has no meaning in Markdown, HTML
 * or MDX, so no later step escapes or drops it.
 */
export const REDACTED = "‹redacted›";

/**
 * Key shapes that are never shown, wherever they appear: Stripe live and
 * restricted keys, GitHub tokens, AWS access key IDs, Slack tokens, JWTs
 * and private key blocks.
 */
const SECRET_PATTERNS: readonly RegExp[] = [
  /\b(?:sk|rk)_live_[0-9A-Za-z]{10,}\b/g,
  /\bgh[pousr]_[0-9A-Za-z]{30,}\b/g,
  /\bgithub_pat_[0-9A-Za-z_]{30,}\b/g,
  /\b(?:AKIA|ASIA)[0-9A-Z]{16}\b/g,
  /\bxox[abprs]-[0-9A-Za-z-]{10,}\b/g,
  /\beyJ[0-9A-Za-z_-]{8,}\.eyJ[0-9A-Za-z_-]{8,}\.[0-9A-Za-z_-]{8,}\b/g,
  /-----BEGIN [A-Z ]*PRIVATE KEY-----[\s\S]*?(?:-----END [A-Z ]*PRIVATE KEY-----|$)/g,
];

/** Headers whose example values are credentials. */
const CREDENTIAL_HEADERS: ReadonlySet<string> = new Set([
  "authorization",
  "proxy-authorization",
  "cookie",
  "set-cookie",
]);

/** Counts the secrets that a run removed, for the source report. */
export class SecretRedactor {
  count = 0;

  /** The text with every known key shape replaced. */
  redact(text: string): string {
    let result = text;
    for (const pattern of SECRET_PATTERNS) {
      result = result.replace(pattern, () => {
        this.count += 1;
        return REDACTED;
      });
    }
    return result;
  }

  /**
   * The example of a credential parameter is always redacted: an
   * `Authorization` or `Cookie` header, or the parameter of an API-key
   * scheme. Any other example only loses known key shapes.
   */
  redactExample(example: string, parameterName: string, credentialNames: ReadonlySet<string>): string {
    const lowerName = parameterName.toLowerCase();
    if (CREDENTIAL_HEADERS.has(lowerName) || credentialNames.has(lowerName)) {
      this.count += 1;
      return REDACTED;
    }
    return this.redact(example);
  }
}
