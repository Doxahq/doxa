import { describe, expect, it } from "vitest";
import {
  CloudflareEmailTransport,
  type CloudflareEmailBuilder,
  type CloudflareSendEmailBinding,
  type EmailMessage,
} from "../src";

const message: EmailMessage = {
  from: { address: "no-reply@notification.doxa.so", name: "Doxa" },
  to: [{ address: "ada@example.com" }],
  replyTo: { address: "support@doxa.so" },
  subject: "Hello",
  html: "<p>Hello</p>",
  text: "Hello",
  headers: { "X-Doxa-Template": "team-invite" },
  idempotencyKey: "delivery-1",
};

class RecordingBinding implements CloudflareSendEmailBinding {
  readonly calls: CloudflareEmailBuilder[] = [];
  constructor(private readonly outcome: { messageId: string } | { error: unknown } = { messageId: "cf-1" }) {}

  async send(builder: CloudflareEmailBuilder): Promise<{ messageId: string }> {
    this.calls.push(builder);
    if ("error" in this.outcome) throw this.outcome.error;
    return this.outcome;
  }
}

function bindingError(code: string, text = "refused"): Error {
  return Object.assign(new Error(text), { code });
}

describe("CloudflareEmailTransport", () => {
  it("maps the message to the binding shape and leaves out the idempotency key", async () => {
    const binding = new RecordingBinding();
    const result = await new CloudflareEmailTransport(binding).send(message);

    expect(result).toEqual({ ok: true, provider: "cloudflare", messageId: "cf-1" });
    expect(binding.calls).toEqual([
      {
        from: { email: "no-reply@notification.doxa.so", name: "Doxa" },
        to: ["ada@example.com"],
        replyTo: "support@doxa.so",
        subject: "Hello",
        html: "<p>Hello</p>",
        text: "Hello",
        headers: { "X-Doxa-Template": "team-invite" },
      },
    ]);
  });

  it.each([
    ["E_VALIDATION_ERROR", "invalid_message", false],
    ["E_HEADER_NOT_ALLOWED", "invalid_message", false],
    ["E_SENDER_NOT_VERIFIED", "configuration", false],
    ["E_RECIPIENT_NOT_ALLOWED", "configuration", false],
    ["E_RECIPIENT_SUPPRESSED", "recipient_suppressed", false],
    ["E_DELIVERY_FAILED", "rejected", false],
    ["E_RATE_LIMIT_EXCEEDED", "rate_limited", true],
    ["E_DAILY_LIMIT_EXCEEDED", "quota_exceeded", true],
    ["E_INTERNAL_SERVER_ERROR", "unavailable", true],
    ["E_SOMETHING_NEW", "unavailable", true],
  ] as const)("maps %s to %s", async (code, kind, retryable) => {
    const result = await new CloudflareEmailTransport(
      new RecordingBinding({ error: bindingError(code) }),
    ).send(message);

    expect(result).toEqual({
      ok: false,
      provider: "cloudflare",
      kind,
      retryable,
      message: "refused",
      providerCode: code,
    });
  });

  it("treats a thrown value without a code as a temporary outage", async () => {
    const result = await new CloudflareEmailTransport(
      new RecordingBinding({ error: "socket closed" }),
    ).send(message);

    expect(result).toMatchObject({ ok: false, kind: "unavailable", retryable: true });
    expect(result).not.toHaveProperty("providerCode");
  });
});
