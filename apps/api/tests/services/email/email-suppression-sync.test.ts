import { describe, expect, it, vi } from "vitest";
import type { EmailSuppressionSource, SuppressionPage } from "@doxahq/email";
import { EmailSuppressionSync, isFirstCronRunOfHour } from "../../../src/services/email/email-suppression-sync";
import { InMemoryEmailStore } from "../../support/in-memory-email-store";

function source(pages: Record<string, SuppressionPage>): EmailSuppressionSource {
  return { provider: "cloudflare", listSuppressions: vi.fn(async (cursor) => pages[cursor ?? "first"] ?? { entries: [], nextCursor: null }) };
}

describe("EmailSuppressionSync", () => {
  it("copies every page of the provider list, and keeps an existing reason", async () => {
    const store = new InMemoryEmailStore();
    await store.suppress([{ email: "angry@example.com", reason: "manual", source: "doxa" }]);
    const sync = new EmailSuppressionSync({
      source: source({
        first: { entries: [{ email: "bounced@example.com", reason: "bounce" }], nextCursor: "two" },
        two: { entries: [{ email: "angry@example.com", reason: "complaint" }], nextCursor: null },
      }),
      suppressions: store,
      log: vi.fn(),
    });

    expect(await sync.run()).toBe(1);
    expect(store.suppressions.get("bounced@example.com")).toEqual({ reason: "bounce", source: "cloudflare" });
    expect(store.suppressions.get("angry@example.com")).toEqual({ reason: "manual", source: "doxa" });
  });

  it("is off without the provider settings", () => {
    expect(EmailSuppressionSync.fromEnv({ CLOUDFLARE_ACCOUNT_ID: "acc" })).toBeNull();
  });
});

describe("isFirstCronRunOfHour", () => {
  it("is true only in the first five minutes", () => {
    expect(isFirstCronRunOfHour(Date.parse("2026-10-07T12:00:00Z"))).toBe(true);
    expect(isFirstCronRunOfHour(Date.parse("2026-10-07T12:05:00Z"))).toBe(false);
  });
});
