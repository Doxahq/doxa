import { z } from "zod";
import type {
  EmailSuppressionSource,
  ProviderSuppression,
  SuppressionPage,
  SuppressionReason,
} from "../../suppressions/suppression-source";
import { CLOUDFLARE_PROVIDER } from "./cloudflare-email-transport";

const API_BASE = "https://api.cloudflare.com/client/v4";
const PAGE_SIZE = 1000;

/** Cloudflare reasons. A soft bounce expires, so it is not copied. */
const REASONS: Readonly<Record<string, SuppressionReason | null>> = {
  hard_bounce: "bounce",
  complaint: "complaint",
  manual: "manual",
  policy: "provider",
  soft_bounce: null,
};

const suppressionListSchema = z.object({
  success: z.literal(true),
  result: z.array(
    z.object({
      email: z.string(),
      reason: z.string(),
      expires_at: z.string().nullable().optional(),
    }),
  ),
  result_info: z.object({ next_cursor: z.string().nullable().optional() }).optional(),
});

export interface CloudflareSuppressionSourceOptions {
  readonly accountId: string;
  /** An API token with read access to Email Sending. */
  readonly apiToken: string;
  readonly fetch?: (input: string, init: RequestInit) => Promise<Response>;
}

/**
 * Reads the Cloudflare Email Sending suppression list:
 * `GET /accounts/{account_id}/email/sending/suppressions`.
 */
export class CloudflareSuppressionSource implements EmailSuppressionSource {
  readonly provider = CLOUDFLARE_PROVIDER;
  private readonly fetch: (input: string, init: RequestInit) => Promise<Response>;

  constructor(private readonly options: CloudflareSuppressionSourceOptions) {
    this.fetch = options.fetch ?? ((input, init) => fetch(input, init));
  }

  async listSuppressions(cursor: string | null): Promise<SuppressionPage> {
    const url = new URL(`${API_BASE}/accounts/${encodeURIComponent(this.options.accountId)}/email/sending/suppressions`);
    url.searchParams.set("per_page", String(PAGE_SIZE));
    if (cursor) url.searchParams.set("cursor", cursor);

    const response = await this.fetch(url.href, {
      method: "GET",
      headers: { authorization: `Bearer ${this.options.apiToken}` },
    });
    if (!response.ok) throw new Error(`Cloudflare suppression list answered ${response.status}.`);
    const body = suppressionListSchema.parse(await response.json());

    return {
      entries: body.result.flatMap((entry): ProviderSuppression[] => {
        const reason = REASONS[entry.reason] ?? null;
        if (!reason || entry.expires_at) return [];
        return [{ email: entry.email.trim().toLowerCase(), reason }];
      }),
      nextCursor: body.result_info?.next_cursor || null,
    };
  }
}
