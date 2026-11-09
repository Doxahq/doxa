const SECRET_BYTES = 32;
const AGENT_TOKEN_PREFIX = "doxa_at_";
const CLAIM_TOKEN_PREFIX = "doxa_clm_";
const AGENT_TOKEN_PATTERN = /^doxa_at_[A-Za-z0-9_-]{43}$/;
const CLAIM_TOKEN_PATTERN = /^doxa_clm_[A-Za-z0-9_-]{43}$/;

const USER_CODE_SPACE = 1_000_000;
const USER_CODE_LENGTH = 6;
/** Values at or above this limit are redrawn, so that every code is equally likely. */
const UNBIASED_UINT32_LIMIT = Math.floor(2 ** 32 / USER_CODE_SPACE) * USER_CODE_SPACE;

/** Held only by the agent. It collects the agent token. */
export function newClaimToken(): string {
  return `${CLAIM_TOKEN_PREFIX}${randomSecret()}`;
}

/** Goes in the link that the person opens. */
export function newAttemptToken(): string {
  return randomSecret();
}

export function newAgentToken(): string {
  return `${AGENT_TOKEN_PREFIX}${randomSecret()}`;
}

export function newUserCode(): string {
  const value = new Uint32Array(1);
  do {
    crypto.getRandomValues(value);
  } while (value[0]! >= UNBIASED_UINT32_LIMIT);
  return String(value[0]! % USER_CODE_SPACE).padStart(USER_CODE_LENGTH, "0");
}

export function isAgentToken(value: string): boolean {
  return AGENT_TOKEN_PATTERN.test(value);
}

export function isClaimToken(value: string): boolean {
  return CLAIM_TOKEN_PATTERN.test(value);
}

export async function sha256Hex(value: string): Promise<string> {
  const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(value));
  return [...new Uint8Array(digest)].map((byte) => byte.toString(16).padStart(2, "0")).join("");
}

/**
 * A hash of a 6-digit code alone can be reversed by trying a million values.
 * The attempt token is high entropy and is not stored, so a copy of the
 * database does not reveal the code.
 */
export function userCodeHash(attemptToken: string, userCode: string): Promise<string> {
  return sha256Hex(`${attemptToken}:${userCode}`);
}

function randomSecret(): string {
  const bytes = crypto.getRandomValues(new Uint8Array(SECRET_BYTES));
  let binary = "";
  for (const byte of bytes) binary += String.fromCharCode(byte);
  return btoa(binary).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}
