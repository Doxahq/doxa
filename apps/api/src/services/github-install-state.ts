/** Domain separation: this key material signs nothing else with this prefix. */
const STATE_CONTEXT = "doxa.github-install.v1:";

/** The person has this long to authorize on GitHub after the install redirect. */
export const INSTALL_STATE_TTL_SECONDS = 10 * 60;

/** Holds the nonce of the state, so a state works only in the browser that started the flow. */
export const INSTALL_NONCE_COOKIE = "doxa_github_install";

/** The cookie goes only to the install routes. */
export const INSTALL_NONCE_COOKIE_PATH = "/github/install";

const NONCE_PATTERN = /^[A-Za-z0-9_-]{43}$/;

/** What the OAuth `state` of the install flow carries. */
export interface InstallState {
  userId: string;
  installationId: string;
  nonce: string;
  /** Unix seconds. */
  expiresAt: number;
}

/**
 * Signs the OAuth `state` of the GitHub App install flow:
 * base64url(JSON) + "." + base64url(HMAC-SHA256(secret, context + payload)).
 * The state binds the Doxa user, the installation ID and a browser nonce.
 */
export class InstallStateSigner {
  private key: Promise<CryptoKey> | null = null;

  constructor(private readonly secret: string) {}

  async sign(state: InstallState): Promise<string> {
    const payload = base64Url(
      new TextEncoder().encode(
        JSON.stringify({
          u: state.userId,
          i: state.installationId,
          n: state.nonce,
          e: state.expiresAt,
        }),
      ),
    );
    const signature = await crypto.subtle.sign(
      "HMAC",
      await this.signingKey(),
      new TextEncoder().encode(`${STATE_CONTEXT}${payload}`),
    );
    return `${payload}.${base64Url(new Uint8Array(signature))}`;
  }

  /** The state, or null when the signature is wrong, the shape is wrong, or it expired. */
  async verify(value: string, nowSeconds: number): Promise<InstallState | null> {
    const [payload, signature, extra] = value.split(".");
    if (!payload || !signature || extra !== undefined) return null;

    const signatureBytes = fromBase64Url(signature);
    if (!signatureBytes) return null;
    const valid = await crypto.subtle.verify(
      "HMAC",
      await this.signingKey(),
      toArrayBuffer(signatureBytes),
      new TextEncoder().encode(`${STATE_CONTEXT}${payload}`),
    );
    if (!valid) return null;

    const payloadBytes = fromBase64Url(payload);
    if (!payloadBytes) return null;
    const state = parseState(new TextDecoder().decode(payloadBytes));
    if (!state || state.expiresAt <= nowSeconds) return null;

    return state;
  }

  /** Imported once, on first use. */
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

/** 32 random bytes, base64url: 43 characters. */
export function createInstallNonce(): string {
  return base64Url(crypto.getRandomValues(new Uint8Array(32)));
}

export function isInstallNonce(value: string | undefined): value is string {
  return value !== undefined && NONCE_PATTERN.test(value);
}

/** Compares two nonces in time that does not depend on where they differ. */
export function sameNonce(left: string, right: string): boolean {
  if (left.length !== right.length) return false;

  let difference = 0;
  for (let index = 0; index < left.length; index += 1) {
    difference |= left.charCodeAt(index) ^ right.charCodeAt(index);
  }
  return difference === 0;
}

function parseState(text: string): InstallState | null {
  let value: unknown;
  try {
    value = JSON.parse(text);
  } catch {
    return null;
  }
  if (!value || typeof value !== "object") return null;

  const { u, i, n, e } = value as Record<string, unknown>;
  if (
    typeof u !== "string" ||
    u.length === 0 ||
    typeof i !== "string" ||
    i.length === 0 ||
    typeof n !== "string" ||
    !isInstallNonce(n) ||
    typeof e !== "number" ||
    !Number.isSafeInteger(e)
  ) {
    return null;
  }

  return { userId: u, installationId: i, nonce: n, expiresAt: e };
}

function base64Url(bytes: Uint8Array): string {
  let binary = "";
  for (const byte of bytes) binary += String.fromCharCode(byte);
  return btoa(binary).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}

function fromBase64Url(value: string): Uint8Array | null {
  if (!/^[A-Za-z0-9_-]+$/.test(value)) return null;

  const base64 = value.replace(/-/g, "+").replace(/_/g, "/");
  try {
    return Uint8Array.from(
      atob(base64.padEnd(Math.ceil(base64.length / 4) * 4, "=")),
      (char) => char.charCodeAt(0),
    );
  } catch {
    return null;
  }
}

function toArrayBuffer(bytes: Uint8Array): ArrayBuffer {
  const out = new Uint8Array(bytes.byteLength);
  out.set(bytes);
  return out.buffer;
}
