import { describe, expect, it, vi } from "vitest";

vi.mock("cloudflare:workers", () => ({ WorkerEntrypoint: class {} }));

const { KvPendingConsentStore, PENDING_CONSENT_TTL_SECONDS, isConsentId, newConsentId } =
  await import("../../../src/services/oauth/pending-consent-store");
const { createMemoryKv } = await import("./memory-kv");
const { CONSENT_ID, pendingConsent } = await import("./fixtures");

describe("KvPendingConsentStore", () => {
  it("round-trips a consent under its prefixed key with a TTL", async () => {
    const { kv } = createMemoryKv();
    const put = vi.spyOn(kv, "put");
    const store = new KvPendingConsentStore(kv);

    await store.save(CONSENT_ID, pendingConsent());

    expect(put).toHaveBeenCalledWith(`agent-consent:${CONSENT_ID}`, expect.any(String), {
      expirationTtl: PENDING_CONSENT_TTL_SECONDS,
    });
    expect(await store.find(CONSENT_ID)).toEqual(pendingConsent());
  });

  it("keeps request fields that a later provider version adds", async () => {
    const { kv } = createMemoryKv();
    const store = new KvPendingConsentStore(kv);
    const consent = pendingConsent();
    await kv.put(
      `agent-consent:${CONSENT_ID}`,
      JSON.stringify({ ...consent, authRequest: { ...consent.authRequest, nonce: "n-1" } }),
    );

    const found = await store.find(CONSENT_ID);

    expect(found?.authRequest).toMatchObject({ nonce: "n-1" });
  });

  it.each([["not json"], [JSON.stringify({ authRequest: {} })]])(
    "returns null for a damaged record %#",
    async (raw) => {
      const { kv } = createMemoryKv();
      await kv.put(`agent-consent:${CONSENT_ID}`, raw);

      expect(await new KvPendingConsentStore(kv).find(CONSENT_ID)).toBeNull();
    },
  );

  it("removes a consent", async () => {
    const { kv, entries } = createMemoryKv();
    const store = new KvPendingConsentStore(kv);
    await store.save(CONSENT_ID, pendingConsent());

    await store.remove(CONSENT_ID);

    expect(entries.size).toBe(0);
  });
});

describe("consent IDs", () => {
  it("are 32 random bytes in base64url", () => {
    const id = newConsentId();

    expect(id).toMatch(/^[A-Za-z0-9_-]{43}$/);
    expect(isConsentId(id)).toBe(true);
    expect(newConsentId()).not.toBe(id);
  });

  it.each(["", "short", "a".repeat(44), `${"a".repeat(42)}:`])("rejects %j", (value) => {
    expect(isConsentId(value)).toBe(false);
  });
});
