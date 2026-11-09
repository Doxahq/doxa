import { describe, expect, it } from "vitest";
import { LogEmailTransport } from "../src";
import { EMAIL_KINDS, streamOf, type TeamInviteEmailProps } from "../src/catalog";
import {
  Mailer,
  findEmailTemplate,
  generationFinishedTemplate,
  renderEmailTemplate,
  teamInviteTemplate,
} from "../src/mailer-entry";
import { MemoryEmailTransport } from "../src/testing";

const invite: TeamInviteEmailProps = {
  inviterName: "Ada <script>",
  teamName: "Engines & Co",
  role: "editor",
  acceptUrl: "https://doxa.so/invite/token-1",
  expiresInDays: 7,
};

const SENDERS = {
  transactional: { from: { address: "no-reply@invites.doxa.so", name: "Doxa" }, replyTo: { address: "support@doxa.so" } },
  notifications: { from: { address: "no-reply@notification.doxa.so", name: "Doxa" }, replyTo: { address: "support@doxa.so" } },
};

function createMailer(transport = new MemoryEmailTransport()) {
  const mailer = new Mailer({
    transport,
    senders: SENDERS,
  });
  return { mailer, transport };
}

describe("Mailer", () => {
  it("renders the template and sends it with the sender defaults", async () => {
    const { mailer, transport } = createMailer();
    const result = await mailer.send(teamInviteTemplate, invite, {
      to: { address: "grace@example.com" },
      idempotencyKey: "delivery-1",
    });

    expect(result).toEqual({ ok: true, provider: "memory", messageId: "memory-1" });
    const [sent] = transport.sent;
    expect(sent).toMatchObject({
      from: { address: "no-reply@invites.doxa.so", name: "Doxa" },
      replyTo: { address: "support@doxa.so" },
      to: [{ address: "grace@example.com" }],
      subject: "Ada <script> invited you to Engines & Co on Doxa",
      headers: { "X-Doxa-Template": "team-invite" },
      idempotencyKey: "delivery-1",
    });
    expect(sent?.html).toContain('href="https://doxa.so/invite/token-1"');
    expect(sent?.html).not.toContain("<script>");
    expect(sent?.text).toContain("https://doxa.so/invite/token-1");
  });

  it("does not call the provider for a message that no provider accepts", async () => {
    const { mailer, transport } = createMailer();
    const result = await mailer.send(teamInviteTemplate, invite, { to: [] });

    expect(result).toMatchObject({ ok: false, kind: "invalid_message", retryable: false });
    expect(transport.sent).toHaveLength(0);
  });

  it("passes a provider failure through unchanged", async () => {
    const transport = new MemoryEmailTransport();
    transport.failNextWith("rate_limited");
    const { mailer } = createMailer(transport);

    const result = await mailer.send(teamInviteTemplate, invite, { to: { address: "grace@example.com" } });
    expect(result).toMatchObject({ ok: false, provider: "memory", kind: "rate_limited", retryable: true });
  });

  it("works the same with another transport", async () => {
    const lines: string[] = [];
    const logMailer = new Mailer({
      transport: new LogEmailTransport({ write: (line) => lines.push(line), newId: () => "1" }),
      senders: SENDERS,
    });

    const result = await logMailer.send(teamInviteTemplate, invite, { to: { address: "grace@example.com" } });
    expect(result).toEqual({ ok: true, provider: "log", messageId: "log-1" });
    expect(lines[0]).toContain("Subject: Ada <script> invited you to Engines & Co on Doxa");
  });
});

describe("sending streams", () => {
  it("sends a notification from the notifications sender", async () => {
    const { mailer, transport } = createMailer();
    await mailer.send(
      generationFinishedTemplate,
      {
        projectName: "Engines Docs",
        outcome: "succeeded",
        generationUrl: "https://doxa.so/dashboard/projects/p/generations/g",
        unsubscribeUrl: "https://doxa.so/email/unsubscribe?x=1",
      },
      { to: { address: "grace@example.com" } },
    );
    expect(transport.sent[0]?.from).toEqual({ address: "no-reply@notification.doxa.so", name: "Doxa" });
  });

  it("maps every category to a stream", () => {
    expect(EMAIL_KINDS.map((kind) => [kind.name, streamOf(kind.category)])).toEqual([
      ["team-invite", "transactional"],
      ["approval-requested", "notifications"],
      ["approval-decided", "notifications"],
      ["generation-finished", "notifications"],
      ["domain-status-changed", "notifications"],
      ["verify-email", "transactional"],
      ["reset-password", "transactional"],
      ["agent-connected", "transactional"],
    ]);
  });
});

describe("teamInviteTemplate", () => {
  it("refuses a link that is not https", async () => {
    await expect(
      renderEmailTemplate(teamInviteTemplate, { ...invite, acceptUrl: "javascript:alert(1)" }),
    ).rejects.toThrow(/must use https/);
  });

  it("allows http links to localhost for local development", async () => {
    const rendered = await renderEmailTemplate(teamInviteTemplate, {
      ...invite,
      acceptUrl: "http://localhost:3001/invite/token-1",
    });
    expect(rendered.html).toContain("http://localhost:3001/invite/token-1");
  });
});

describe("Mailer.sendStored", () => {
  it("sends props read from storage after it checks them", async () => {
    const { mailer, transport } = createMailer();
    const stored: unknown = JSON.parse(JSON.stringify(invite));

    const result = await mailer.sendStored(teamInviteTemplate, stored, { to: { address: "grace@example.com" } });
    expect(result).toMatchObject({ ok: true });
    expect(transport.sent).toHaveLength(1);
  });

  it("refuses stored props that do not match the kind", async () => {
    const { mailer, transport } = createMailer();
    const result = await mailer.sendStored(
      teamInviteTemplate,
      { ...invite, role: "superuser" },
      { to: { address: "grace@example.com" } },
    );

    expect(result).toMatchObject({ ok: false, kind: "invalid_message", message: 'Props for "team-invite" are not valid.' });
    expect(transport.sent).toHaveLength(0);
  });
});

describe("findEmailTemplate", () => {
  it("finds a template for every email kind", () => {
    for (const kind of EMAIL_KINDS) {
      expect(findEmailTemplate(kind.name)?.kind).toBe(kind);
    }
  });

  it.each(["unknown", "toString", "__proto__"])("finds nothing for %j", (name) => {
    expect(findEmailTemplate(name)).toBeUndefined();
  });
});
