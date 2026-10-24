import {
  EMAIL_NOTIFICATION_CATEGORIES,
  type EmailNotificationCategory,
} from "../catalog/define-email-kind";

/** Domain separation: this key signs nothing else with this prefix. */
const TOKEN_CONTEXT = "doxa.email-unsubscribe.v1:";

export interface UnsubscribeTarget {
  readonly userId: string;
  readonly category: EmailNotificationCategory;
}

/**
 * Signs and checks one-click unsubscribe links. A link names one user and one
 * category, so it turns off only that category, and it needs no database row.
 * token = base64url(HMAC-SHA256(secret, context + userId + ":" + category)).
 */
export class UnsubscribeTokens {
  private key: Promise<CryptoKey> | null = null;

  constructor(private readonly secret: string) {
    if (secret.length < 32) throw new Error("The unsubscribe secret must have at least 32 characters.");
  }

  async tokenFor(target: UnsubscribeTarget): Promise<string> {
    return base64Url(new Uint8Array(await crypto.subtle.sign("HMAC", await this.signingKey(), payload(target))));
  }

  /** Constant-time check through `crypto.subtle.verify`. */
  async verify(target: UnsubscribeTarget, token: string): Promise<boolean> {
    const signature = fromBase64Url(token);
    if (!signature) return false;
    return crypto.subtle.verify("HMAC", await this.signingKey(), signature, payload(target));
  }

  /** The page that confirms the unsubscribe. The same URL accepts the one-click POST (RFC 8058). */
  async urlFor(baseUrl: string, target: UnsubscribeTarget): Promise<string> {
    const url = new URL(baseUrl);
    url.searchParams.set("user", target.userId);
    url.searchParams.set("category", target.category);
    url.searchParams.set("token", await this.tokenFor(target));
    return url.href;
  }

  private signingKey(): Promise<CryptoKey> {
    this.key ??= crypto.subtle.importKey(
      "raw",
      new TextEncoder().encode(this.secret),
      { name: "HMAC", hash: "SHA-256" },
      false,
      ["sign", "verify"],
    );
    return this.key;
  }
}

/** Reads `user`, `category` and `token` from an unsubscribe URL's query. */
export function readUnsubscribeQuery(
  params: URLSearchParams,
): { readonly target: UnsubscribeTarget; readonly token: string } | null {
  const userId = params.get("user");
  const category = params.get("category");
  const token = params.get("token");
  if (!userId || !token || !isNotificationCategoryName(category)) return null;
  return { target: { userId, category }, token };
}

/** Headers that let mail clients show an Unsubscribe button (RFC 2369 and RFC 8058). */
export function unsubscribeHeaders(unsubscribeUrl: string): Record<string, string> {
  return {
    "List-Unsubscribe": `<${unsubscribeUrl}>`,
    "List-Unsubscribe-Post": "List-Unsubscribe=One-Click",
  };
}

function isNotificationCategoryName(value: string | null): value is EmailNotificationCategory {
  return EMAIL_NOTIFICATION_CATEGORIES.some((category) => category === value);
}

function payload({ userId, category }: UnsubscribeTarget): Uint8Array<ArrayBuffer> {
  return new TextEncoder().encode(`${TOKEN_CONTEXT}${userId}:${category}`);
}

function base64Url(bytes: Uint8Array): string {
  let binary = "";
  for (const byte of bytes) binary += String.fromCharCode(byte);
  return btoa(binary).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}

const TOKEN_PATTERN = /^[A-Za-z0-9_-]{43}$/;

function fromBase64Url(token: string): Uint8Array<ArrayBuffer> | null {
  if (!TOKEN_PATTERN.test(token)) return null;
  const binary = atob(token.replace(/-/g, "+").replace(/_/g, "/"));
  return Uint8Array.from(binary, (char) => char.charCodeAt(0));
}
