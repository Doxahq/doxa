import { describe, expect, it } from "vitest";
import {
  CloudflareEmailTransport,
  EmailConfigurationError,
  LogEmailTransport,
  createEmailTransport,
  readSenders,
  type CloudflareSendEmailBinding,
} from "../src";
import { Mailer } from "../src/mailer-entry";

const binding: CloudflareSendEmailBinding = { send: async () => ({ messageId: "cf-1" }) };

describe("createEmailTransport", () => {
  it("builds the provider that EMAIL_PROVIDER names", () => {
    expect(createEmailTransport({ EMAIL_PROVIDER: "cloudflare", EMAIL: binding })).toBeInstanceOf(
      CloudflareEmailTransport,
    );
    expect(createEmailTransport({ EMAIL_PROVIDER: " log " })).toBeInstanceOf(LogEmailTransport);
  });

  it.each([
    [{}, /set EMAIL_PROVIDER/],
    [{ EMAIL_PROVIDER: "resend" }, /"resend" is not known. Use one of: cloudflare, log/],
    [{ EMAIL_PROVIDER: "toString" }, /"toString" is not known/],
    [{ EMAIL_PROVIDER: "cloudflare" }, /set the EMAIL send_email binding/],
  ])("refuses %j", (env, message) => {
    expect(() => createEmailTransport(env)).toThrow(EmailConfigurationError);
    expect(() => createEmailTransport(env)).toThrow(message);
  });
});

describe("readSenders", () => {
  it("reads one sender for each stream and the shared reply address", () => {
    expect(
      readSenders({
        EMAIL_FROM_TRANSACTIONAL: "Doxa <no-reply@invites.doxa.so>",
        EMAIL_FROM_NOTIFICATIONS: "Doxa <no-reply@notification.doxa.so>",
        EMAIL_REPLY_TO: "support@doxa.so",
      }),
    ).toEqual({
      transactional: { from: { address: "no-reply@invites.doxa.so", name: "Doxa" }, replyTo: { address: "support@doxa.so" } },
      notifications: { from: { address: "no-reply@notification.doxa.so", name: "Doxa" }, replyTo: { address: "support@doxa.so" } },
    });
  });

  it("refuses a missing or invalid stream sender", () => {
    expect(() => readSenders({ EMAIL_FROM_NOTIFICATIONS: "n@notification.doxa.so" })).toThrow(/set EMAIL_FROM_TRANSACTIONAL/);
    expect(() => readSenders({ EMAIL_FROM_TRANSACTIONAL: "t@doxa.so", EMAIL_FROM_NOTIFICATIONS: "Doxa" })).toThrow(
      /EMAIL_FROM_NOTIFICATIONS is not one valid email address/,
    );
  });
});

describe("Mailer.fromEnv", () => {
  it("wires the transport and the sender from the environment", () => {
    const mailer = Mailer.fromEnv({
      EMAIL_PROVIDER: "cloudflare",
      EMAIL: binding,
      EMAIL_FROM_TRANSACTIONAL: "a@notification.doxa.so",
      EMAIL_FROM_NOTIFICATIONS: "a@notification.doxa.so",
    });
    expect(mailer.provider).toBe("cloudflare");
  });
});
