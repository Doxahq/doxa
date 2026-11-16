import { describe, expect, it } from "vitest";

import { DOXA_CATALOG, PlanLimitError, createDocsChatBilling, defineCatalog, type Catalog } from "../src/index";
import { createTestBilling, type TestBilling } from "../src/testing";
import { accountWithCredits } from "./helpers/fixtures";

/** The catalog once the chat project sets a price (spec 10.9). */
const liveChat: Catalog = defineCatalog({
  ...DOXA_CATALOG,
  actions: {
    ...DOXA_CATALOG.actions,
    "docs_chat.answer": {
      status: "live",
      feature: "ai.docs_chat",
      pricing: {
        kind: "metered",
        base: 2,
        minCap: 10,
        defaultCap: 50,
        maxCap: 100,
        inFlightMarginCredits: 10,
        defaultEstimateCredits: 10,
        charge: { answered: "base+usage", no_answer: "none", failed: "none" },
      },
      perSiteDailyCapCredits: 1_000,
    },
  },
});

/** A fake chat flow: one model call, then an outcome. */
async function chat(billing: TestBilling, requestId: string, outcome: "answered" | "no_answer" | "failed") {
  const account = await accountWithCredits(billing, 1_000);
  await billing.store.insertOverride(
    { accountId: account.id, key: "plan", value: "pro", reason: "test", startsAt: null, expiresAt: null, createdBy: "test" },
    billing.clock.now(),
  );
  const port = createDocsChatBilling({
    catalog: billing.catalog,
    meter: billing.meter,
    resolveSite: async () => ({ accountId: account.id, entitlements: (await billing.entitlements.forAccount(account.id)).entitlements }),
  });
  const session = await port.begin("site_1", requestId);
  await session.accrue({ callId: `${requestId}:1`, costUsd: 0.01 });
  return session.finish(outcome);
}

describe("docs chat billing port", () => {
  it("is coming_soon while the action is planned", async () => {
    const billing = createTestBilling();
    const error = await chat(billing, "q0", "answered").catch((caught: unknown) => caught);
    expect(error).toBeInstanceOf(PlanLimitError);
    expect(error).toMatchObject({ code: "plan_limit", details: { key: "ai.docs_chat", reason: "coming_soon" } });
  });

  it("charges an answer: base + usage", async () => {
    expect(await chat(createTestBilling({ catalog: liveChat }), "q1", "answered")).toEqual({ charged: 2 + 3 });
  });

  it("charges nothing for no answer or an error", async () => {
    expect(await chat(createTestBilling({ catalog: liveChat }), "q2", "no_answer")).toEqual({ charged: 0 });
    expect(await chat(createTestBilling({ catalog: liveChat }), "q3", "failed")).toEqual({ charged: 0 });
  });
});
