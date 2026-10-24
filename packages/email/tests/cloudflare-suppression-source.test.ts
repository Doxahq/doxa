import { describe, expect, it, vi } from "vitest";
import { CloudflareSuppressionSource } from "../src";

function answer(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });
}

describe("CloudflareSuppressionSource", () => {
  it("reads one page and keeps only permanent entries", async () => {
    const fetch = vi.fn(async () =>
      answer({
        success: true,
        result: [
          { email: "Bounced@Example.com", reason: "hard_bounce", expires_at: null },
          { email: "angry@example.com", reason: "complaint" },
          { email: "blocked@example.com", reason: "policy", expires_at: null },
          { email: "soft@example.com", reason: "soft_bounce", expires_at: "2026-10-08T00:00:00Z" },
          { email: "later@example.com", reason: "manual", expires_at: "2026-12-01T00:00:00Z" },
          { email: "new@example.com", reason: "a_future_reason" },
        ],
        result_info: { next_cursor: "cursor-2" },
      }),
    );
    const source = new CloudflareSuppressionSource({ accountId: "acc 1", apiToken: "token", fetch });

    const page = await source.listSuppressions("cursor-1");

    expect(page).toEqual({
      entries: [
        { email: "bounced@example.com", reason: "bounce" },
        { email: "angry@example.com", reason: "complaint" },
        { email: "blocked@example.com", reason: "provider" },
      ],
      nextCursor: "cursor-2",
    });
    expect(fetch).toHaveBeenCalledWith(
      "https://api.cloudflare.com/client/v4/accounts/acc%201/email/sending/suppressions?per_page=1000&cursor=cursor-1",
      { method: "GET", headers: { authorization: "Bearer token" } },
    );
  });

  it("ends on a page without a cursor", async () => {
    const source = new CloudflareSuppressionSource({
      accountId: "acc",
      apiToken: "token",
      fetch: async () => answer({ success: true, result: [], result_info: { next_cursor: null } }),
    });
    await expect(source.listSuppressions(null)).resolves.toEqual({ entries: [], nextCursor: null });
  });

  it("throws for an error answer", async () => {
    const source = new CloudflareSuppressionSource({
      accountId: "acc",
      apiToken: "token",
      fetch: async () => answer({ success: false, errors: [] }, 403),
    });
    await expect(source.listSuppressions(null)).rejects.toThrow("answered 403");
  });
});
