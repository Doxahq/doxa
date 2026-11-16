import { describe, expect, it } from "vitest";
import {
  creditsExhaustedTemplate,
  creditsLowTemplate,
  paygLimitTemplate,
  paygStartedTemplate,
  renderEmailTemplate,
} from "../src/mailer-entry";
import { creditsLowEmail, paygLimitEmail } from "../src/catalog";

const billingUrl = "https://doxa.so/dashboard/billing/acct-1";

describe("billing email templates (billing spec 10.7)", () => {
  it("credits-low states the use and links to the billing page", async () => {
    const out = await renderEmailTemplate(creditsLowTemplate, {
      billingUrl,
      usedCredits: 4_000,
      allowanceCredits: 5_000,
      resetsOn: "December 1, 2026",
      paygOn: true,
    });
    expect(out.subject).toBe("80% of your AI credits are used");
    expect(out.text).toContain("Your account used 4000 of its 5000 AI credits this month.");
    expect(out.text).toContain("continue on pay-as-you-go");
    expect(out.html).toContain(billingUrl);
    expect(out.html).not.toContain("Unsubscribe from these emails");
  });

  it("credits-low without pay-as-you-go says that runs stop", async () => {
    const out = await renderEmailTemplate(creditsLowTemplate, {
      teamName: "Acme",
      billingUrl,
      usedCredits: 4_100,
      allowanceCredits: 5_000,
      resetsOn: "December 1, 2026",
      paygOn: false,
    });
    expect(out.subject).toBe("80% of your AI credits are used for Acme");
    expect(out.text).toContain("The Acme team used 4100");
    expect(out.text).toContain("AI runs stop until the credits reset");
    expect(out.text).toContain("you manage billing for the Acme team");
  });

  it("payg-started says that Doxa charges the card automatically, with no Pay now link", async () => {
    const out = await renderEmailTemplate(paygStartedTemplate, {
      billingUrl,
      chargeAtUsd: "$5",
      monthlyLimitUsd: "$30",
      resetsOn: "December 1, 2026",
    });
    expect(out.subject).toBe("Pay-as-you-go started");
    expect(out.text).toContain("Doxa charges your card automatically when your balance reaches $5, and once a month.");
    expect(out.text).toContain("Your monthly limit is $30.");
    expect(out.text.toLowerCase()).not.toContain("pay now");
  });

  it.each([
    [50, "50% of your pay-as-you-go limit is used", "Open billing"],
    [80, "80% of your pay-as-you-go limit is used", "Open billing"],
    [100, "You reached your pay-as-you-go limit", "Raise the limit"],
  ] as const)("payg-limit %i%%", async (percent, subject, action) => {
    const out = await renderEmailTemplate(paygLimitTemplate, {
      billingUrl,
      percent,
      spentUsd: "$24",
      monthlyLimitUsd: "$30",
      chargeAtUsd: "$5",
      resetsOn: "December 1, 2026",
    });
    expect(out.subject).toBe(subject);
    expect(out.text).toContain(action);
    expect(out.text).toContain("Your account used $24 of its $30 monthly pay-as-you-go limit.");
    expect(out.text.toLowerCase()).not.toContain("pay now");
  });

  it("credits-exhausted tells a trial account that runs stopped", async () => {
    const out = await renderEmailTemplate(creditsExhaustedTemplate, { billingUrl, trialCredits: 1_000 });
    expect(out.subject).toBe("Your trial credits are used up");
    expect(out.text).toContain("Your account used all its 1000 trial credits. AI runs stop until the paid plan starts.");
    expect(out.html).toContain(billingUrl);
  });

  it("the schemas refuse a bad percent and a bad amount", () => {
    expect(paygLimitEmail.props.safeParse({ billingUrl, percent: 70, spentUsd: "$1", monthlyLimitUsd: "$30", chargeAtUsd: "$5", resetsOn: "x" }).success).toBe(false);
    expect(creditsLowEmail.props.safeParse({ billingUrl: "javascript:alert(1)", usedCredits: 1, allowanceCredits: 2, resetsOn: "x", paygOn: true }).success).toBe(false);
  });
});
