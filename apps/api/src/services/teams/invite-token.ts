const TOKEN_PATTERN = /^[A-Za-z0-9_-]{43}$/;

/** Domain separation: this key material signs nothing else with this prefix. */
const TOKEN_CONTEXT = "doxa.team-invite.v1:";

/**
 * Gives the token of an invite link. The token is derived from the invite ID,
 * so the dashboard can show the link again while the store keeps only its hash.
 */
export interface InviteTokens {
  tokenFor(inviteId: string): Promise<string>;
}

/**
 * token = base64url(HMAC-SHA256(secret, context + inviteId)), 43 characters.
 * Without the secret, an invite ID gives no token.
 */
export class HmacInviteTokens implements InviteTokens {
  private key: Promise<CryptoKey> | null = null;

  constructor(private readonly secret: string) {}

  async tokenFor(inviteId: string): Promise<string> {
    const signature = await crypto.subtle.sign(
      "HMAC",
      await this.signingKey(),
      new TextEncoder().encode(`${TOKEN_CONTEXT}${inviteId}`),
    );
    return base64Url(new Uint8Array(signature));
  }

  /** Imported once, on first use. */
  private signingKey(): Promise<CryptoKey> {
    this.key ??= crypto.subtle.importKey(
      "raw",
      new TextEncoder().encode(this.secret),
      { name: "HMAC", hash: "SHA-256" },
      false,
      ["sign"],
    );
    return this.key;
  }
}

/** A string that cannot be a token never reaches the database. */
export function isInviteToken(value: string): boolean {
  return TOKEN_PATTERN.test(value);
}

/** Only this hash is stored (v2 spec §5), as lowercase hex. */
export async function hashInviteToken(token: string): Promise<string> {
  const digest = await crypto.subtle.digest(
    "SHA-256",
    new TextEncoder().encode(token),
  );
  return [...new Uint8Array(digest)]
    .map((byte) => byte.toString(16).padStart(2, "0"))
    .join("");
}

function base64Url(bytes: Uint8Array): string {
  let binary = "";
  for (const byte of bytes) binary += String.fromCharCode(byte);
  return btoa(binary).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}
