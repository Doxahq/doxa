import { describe, expect, it, vi } from "vitest";
import type { ClaimedEmailDelivery, EmailAttempt, EmailDeliveryRpc } from "@doxahq/email";
import { Mailer, findEmailTemplate } from "@doxahq/email/mailer";
import { MemoryEmailTransport } from "@doxahq/email/testing";
import { processDelivery } from "../src/process-delivery";

const inviteProps = {
  inviterName: "Ada",
  teamName: "Engines",
  role: "editor",
  acceptUrl: "https://doxa.so/invite/token",
  expiresInDays: 7,
};

const claim: ClaimedEmailDelivery = {
  id: "delivery-1",
  kind: "team-invite",
  props: inviteProps,
  headers: { "X-Doxa-Test": "1" },
  recipientEmail: "grace@example.com",
  claimToken: "claim-1",
  attempt: 1,
};

function setup(options: { claimed?: ClaimedEmailDelivery | null; retryAfterSeconds?: number | null } = {}) {
  const transport = new MemoryEmailTransport();
  const attempts: EmailAttempt[] = [];
  const api: EmailDeliveryRpc = {
    claimEmailDelivery: vi.fn(async () => (options.claimed === undefined ? claim : options.claimed)),
    recordEmailAttempt: vi.fn(async (attempt: EmailAttempt) => {
      attempts.push(attempt);
      return { retryAfterSeconds: options.retryAfterSeconds ?? null };
    }),
  };
  const sender = { from: { address: "no-reply@notification.doxa.so" } };
  const mailer = new Mailer({ transport, senders: { transactional: sender, notifications: sender } });
  const deps = { api, mailer, findTemplate: findEmailTemplate, log: vi.fn() };
  return { deps, transport, attempts, api };
}

describe("processDelivery", () => {
  it("sends the claimed email and records the result", async () => {
    const { deps, transport, attempts } = setup();

    expect(await processDelivery("delivery-1", deps)).toEqual({ action: "ack" });
    expect(transport.sent).toHaveLength(1);
    expect(transport.sent[0]).toMatchObject({
      to: [{ address: "grace@example.com" }],
      idempotencyKey: "delivery-1",
      headers: { "X-Doxa-Test": "1", "X-Doxa-Template": "team-invite" },
    });
    expect(attempts).toEqual([
      {
        deliveryId: "delivery-1",
        claimToken: "claim-1",
        attempt: 1,
        result: { ok: true, provider: "memory", messageId: "memory-1" },
      },
    ]);
  });

  it("acknowledges a message whose row it cannot claim", async () => {
    const { deps, transport, api } = setup({ claimed: null });

    expect(await processDelivery("delivery-1", deps)).toEqual({ action: "ack" });
    expect(transport.sent).toHaveLength(0);
    expect(api.recordEmailAttempt).not.toHaveBeenCalled();
  });

  it("retries the message when the API asks for it", async () => {
    const { deps, transport } = setup({ retryAfterSeconds: 60 });
    transport.failNextWith("rate_limited");

    expect(await processDelivery("delivery-1", deps)).toEqual({ action: "retry", delaySeconds: 60 });
  });

  it("records an unknown kind as an invalid message", async () => {
    const { deps, attempts } = setup({ claimed: { ...claim, kind: "retired-kind" } });

    await processDelivery("delivery-1", deps);
    expect(attempts[0]?.result).toMatchObject({ ok: false, kind: "invalid_message", retryable: false });
  });

  it("records a render failure as an invalid message", async () => {
    const { deps, attempts, transport } = setup({
      claimed: { ...claim, props: { ...inviteProps, acceptUrl: "http://evil.example/x" } },
    });

    await processDelivery("delivery-1", deps);
    expect(transport.sent).toHaveLength(0);
    expect(attempts[0]?.result).toMatchObject({ ok: false, kind: "invalid_message" });
  });

  it("lets an RPC failure reach the queue handler", async () => {
    const { deps, api } = setup();
    vi.mocked(api.claimEmailDelivery).mockRejectedValueOnce(new Error("API down"));

    await expect(processDelivery("delivery-1", deps)).rejects.toThrow("API down");
  });

  it.each([
    ["credits-low", { billingUrl: "https://doxa.so/dashboard/billing/a", usedCredits: 4000, allowanceCredits: 5000, resetsOn: "December 1, 2026", paygOn: true }, "80% of your AI credits are used"],
    ["payg-started", { billingUrl: "https://doxa.so/dashboard/billing/a", chargeAtUsd: "$5", monthlyLimitUsd: "$30", resetsOn: "December 1, 2026" }, "Pay-as-you-go started"],
    ["payg-limit", { teamName: "Acme", billingUrl: "https://doxa.so/dashboard/billing/a", percent: 100, spentUsd: "$30", monthlyLimitUsd: "$30", chargeAtUsd: "$5", resetsOn: "December 1, 2026" }, "You reached your pay-as-you-go limit for Acme"],
    ["credits-exhausted", { billingUrl: "https://doxa.so/dashboard/billing/a", trialCredits: 1000 }, "Your trial credits are used up"],
  ] as const)("sends the billing kind %s from the notifications stream", async (kind, props, subject) => {
    const { deps, transport, attempts } = setup({ claimed: { ...claim, kind, props: { ...props }, headers: {} } });

    expect(await processDelivery("delivery-1", deps)).toEqual({ action: "ack" });
    expect(transport.sent).toHaveLength(1);
    expect(transport.sent[0]).toMatchObject({ subject, headers: { "X-Doxa-Template": kind } });
    expect(attempts[0]?.result).toMatchObject({ ok: true });
  });
});
