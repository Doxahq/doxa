import type { AuthRequest } from "@cloudflare/workers-oauth-provider";
import { z } from "zod";

export const PENDING_CONSENT_TTL_SECONDS = 600;

const CONSENT_KEY_PREFIX = "agent-consent:";
const CONSENT_ID_BYTES = 32;
const CONSENT_ID_PATTERN = /^[A-Za-z0-9_-]{43}$/;

/**
 * Only the client facts the consent page shows. The provider's `ClientInfo`
 * can hold a client secret hash, which must not be copied into another record.
 */
export interface PendingConsentClient {
  readonly clientId: string;
  readonly clientName: string | null;
}

export interface PendingConsent {
  readonly authRequest: AuthRequest;
  readonly client: PendingConsentClient;
  readonly createdAt: string;
}

export interface PendingConsentStore {
  save(id: string, consent: PendingConsent): Promise<void>;
  find(id: string): Promise<PendingConsent | null>;
  remove(id: string): Promise<void>;
}

// `loose` keeps fields that a later provider version adds to AuthRequest, so
// `completeAuthorization` still gets the request it parsed.
const authRequestSchema = z.looseObject({
  responseType: z.string(),
  clientId: z.string(),
  redirectUri: z.string(),
  scope: z.array(z.string()),
  state: z.string(),
  codeChallenge: z.string().optional(),
  codeChallengeMethod: z.string().optional(),
  resource: z.string().optional(),
  issuer: z.string().optional(),
});

const pendingConsentSchema = z.object({
  authRequest: authRequestSchema,
  client: z.object({
    clientId: z.string(),
    clientName: z.string().nullable(),
  }),
  createdAt: z.iso.datetime(),
});

export class KvPendingConsentStore implements PendingConsentStore {
  constructor(private readonly kv: KVNamespace) {}

  async save(id: string, consent: PendingConsent): Promise<void> {
    await this.kv.put(keyFor(id), JSON.stringify(consent), {
      expirationTtl: PENDING_CONSENT_TTL_SECONDS,
    });
  }

  async find(id: string): Promise<PendingConsent | null> {
    const raw = await this.kv.get(keyFor(id), "text");
    if (raw === null) return null;
    return parsePendingConsent(raw);
  }

  async remove(id: string): Promise<void> {
    await this.kv.delete(keyFor(id));
  }
}

export function newConsentId(): string {
  const bytes = crypto.getRandomValues(new Uint8Array(CONSENT_ID_BYTES));
  return base64Url(bytes);
}

/** Rejects IDs we never issue, so they never reach storage. */
export function isConsentId(value: string): boolean {
  return CONSENT_ID_PATTERN.test(value);
}

function keyFor(id: string): string {
  return `${CONSENT_KEY_PREFIX}${id}`;
}

function parsePendingConsent(raw: string): PendingConsent | null {
  try {
    const parsed = pendingConsentSchema.safeParse(JSON.parse(raw));
    return parsed.success ? parsed.data : null;
  } catch {
    return null;
  }
}

function base64Url(bytes: Uint8Array): string {
  let binary = "";
  for (const byte of bytes) binary += String.fromCharCode(byte);
  return btoa(binary).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}
