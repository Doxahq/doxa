/**
 * What a redacted value shows instead. It has no meaning in Markdown, HTML
 * or MDX, so no later step escapes or drops it.
 */
export const REDACTED = "‹redacted›";

/**
 * Key shapes that are never shown, wherever they appear: Stripe live and
 * restricted keys, GitHub tokens, AWS access key IDs, Slack tokens, model
 * provider keys, Google API keys, JWTs and private key blocks.
 */
const SECRET_PATTERNS: readonly RegExp[] = [
  /\b(?:sk|rk)_live_[0-9A-Za-z]{10,}\b/g,
  /\bsk-ant-(?:api|oat|admin)\d{2}-[0-9A-Za-z_-]{20,}/g,
  /\bsk-or-v1-[0-9a-f]{32,}\b/g,
  /\bsk-proj-[0-9A-Za-z_-]{20,}/g,
  /\bAIza[0-9A-Za-z_-]{35}\b/g,
  /\bgh[pousr]_[0-9A-Za-z]{30,}\b/g,
  /\bgithub_pat_[0-9A-Za-z_]{30,}\b/g,
  /\b(?:AKIA|ASIA)[0-9A-Z]{16}\b/g,
  /\bxox[abprs]-[0-9A-Za-z-]{10,}\b/g,
  /\beyJ[0-9A-Za-z_-]{8,}\.eyJ[0-9A-Za-z_-]{8,}\.[0-9A-Za-z_-]{8,}\b/g,
  /-----BEGIN [A-Z ]*PRIVATE KEY-----[\s\S]*?(?:-----END [A-Z ]*PRIVATE KEY-----|$)/g,
];

export interface SecretMatch {
  /** Offset of the match in the text. */
  index: number;
  length: number;
}

/**
 * The first credential in `text`, or null: a known key shape, a password in
 * a URL, or a random-looking value assigned to a secret-like name (SEC-027).
 * The last two skip placeholders, so docs examples such as
 * `postgres://user:password@localhost` or `API_KEY=YOUR_API_KEY` pass.
 */
export function findSecret(text: string): SecretMatch | null {
  let first: SecretMatch | null = null;
  const consider = (match: SecretMatch) => {
    if (first === null || match.index < first.index) first = match;
  };
  for (const pattern of SECRET_PATTERNS) {
    // A fresh copy: the shared patterns are global and keep `lastIndex`.
    const match = new RegExp(pattern.source, pattern.flags.replace("g", "")).exec(text);
    if (match) consider({ index: match.index, length: match[0].length });
  }
  for (const [pattern, minLength] of HEURISTIC_PATTERNS) {
    for (const match of text.matchAll(new RegExp(pattern.source, pattern.flags))) {
      const value = match[1] ?? "";
      if (match.index === undefined || !looksLikeRealSecret(value, minLength)) continue;
      consider({ index: match.index + match[0].lastIndexOf(value), length: value.length });
      break;
    }
  }
  return first;
}

/**
 * Credentials without a known prefix, with the shortest value that counts:
 * the password of a URL (`scheme://user:password@host`, or
 * `scheme://:password@host`, which has no username), and the value of a
 * secret-like name (`api_key: "…"`, `CLIENT_SECRET=…`).
 */
const HEURISTIC_PATTERNS: ReadonlyArray<readonly [RegExp, number]> = [
  [/\b[a-z][a-z0-9+.-]*:\/\/[^\s/:@'"`<>]*:([^\s/@'"`<>]+)@/gi, 8],
  [
    /\b(?:[a-z0-9]+[_-])*(?:secret|token|passw(?:or)?d|pwd|api[_-]?key|access[_-]?key|private[_-]?key|credentials?)["'`]?\s*[:=]\s*["'`]?([A-Za-z0-9_\-+/=.~]+)/gi,
    20,
  ],
];

/** Words and signs that mark a value as a stand-in, not a real secret. */
const PLACEHOLDER_MARKERS =
  /your|example|placeholder|changeme|change[_-]me|redacted|dummy|sample|fake|xxxx|\*\*\*|password|passwd|secret|token|insert|replace|<|>|\$\{|\{\{|\.\.\./i;

function looksLikeRealSecret(value: string, minLength: number): boolean {
  if (value.length < minLength || PLACEHOLDER_MARKERS.test(value)) return false;
  // Random keys mix letters and digits, and repeat few characters.
  if (!/[a-z]/i.test(value) || !/\d/.test(value)) return false;
  return minLength < 20 || shannonEntropy(value) >= 3.5;
}

/** Bits per character. */
function shannonEntropy(value: string): number {
  const counts = new Map<string, number>();
  for (const char of value) counts.set(char, (counts.get(char) ?? 0) + 1);
  let entropy = 0;
  for (const count of counts.values()) {
    const share = count / value.length;
    entropy -= share * Math.log2(share);
  }
  return entropy;
}

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
