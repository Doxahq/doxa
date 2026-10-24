import { describe, expect, it, vi } from "vitest";
import { UnsubscribeTokens, emailFailed, emailSent, readUnsubscribeQuery } from "@doxahq/email";
import { generationFinishedEmail, teamInviteEmail } from "@doxahq/email/catalog";
import { EmailDeliveryService } from "../../../src/services/email/email-delivery-service";
import { EMAIL_SWEEP_LIMITS, EmailDeliverySweeper } from "../../../src/services/email/email-delivery-sweeper";
import { EmailOutbox } from "../../../src/services/email/email-outbox";
import { InMemoryEmailStore, RecordingEmailQueue } from "../../support/in-memory-email-store";

const SECRET = "x".repeat(32);
const START = new Date("2026-10-07T12:00:00Z");
const links = { webOrigin: "https://doxa.so", apiOrigin: "https://api.doxa.so" };

const invite = {
  inviterName: "Ada",
  teamName: "Engines",
  role: "editor" as const,
  acceptUrl: "https://doxa.so/invite/token",
  expiresInDays: 7,
};

const generation = {
  projectName: "Engines Docs",
  outcome: "succeeded" as const,
  generationUrl: "https://doxa.so/dashboard/projects/p/generations/g",
};

function setup() {
  let now = START;
  const clock = () => now;
  const store = new InMemoryEmailStore(clock);
  const queue = new RecordingEmailQueue();
  const log = vi.fn();
  const outbox = new EmailOutbox({
    deliveries: store,
    preferences: store,
    queue,
    unsubscribe: new UnsubscribeTokens(SECRET),
    links,
    log,
  });
  const service = new EmailDeliveryService({ deliveries: store, suppressions: store, now: clock, log });
  const sweeper = new EmailDeliverySweeper({ deliveries: store, queue, now: clock, log });
  return {
    store,
    queue,
    outbox,
    service,
    sweeper,
    advance: (ms: number) => {
      now = new Date(now.getTime() + ms);
    },
  };
}

describe("EmailOutbox", () => {
  it("records the delivery, then sends its ID to the queue", async () => {
    const { outbox, store, queue } = setup();

    const outcome = await outbox.enqueue(teamInviteEmail, invite, { email: " Grace@Example.com ", userId: null }, "team-invite:1");

    expect(outcome).toBe("queued");
    expect(store.deliveries).toHaveLength(1);
    expect(store.deliveries[0]).toMatchObject({
      kind: "team-invite",
      recipientEmail: "grace@example.com",
      props: invite,
      headers: {},
      status: "queued",
    });
    expect(queue.messages).toEqual([{ deliveryId: store.deliveries[0]?.id }]);
  });

  it("does nothing for a second email with the same dedupe key", async () => {
    const { outbox, store, queue } = setup();
    const recipient = { email: "grace@example.com", userId: null };

    await outbox.enqueue(teamInviteEmail, invite, recipient, "team-invite:1");
    expect(await outbox.enqueue(teamInviteEmail, invite, recipient, "team-invite:1")).toBe("duplicate");
    expect(store.deliveries).toHaveLength(1);
    expect(queue.messages).toHaveLength(1);
  });

  it("keeps the row when the queue send fails, for the sweeper", async () => {
    const { outbox, store, queue } = setup();
    queue.failNext();

    expect(await outbox.enqueue(teamInviteEmail, invite, { email: "g@example.com", userId: null }, "k")).toBe("queued");
    expect(store.deliveries[0]?.status).toBe("queued");
    expect(queue.messages).toHaveLength(0);
  });

  it("refuses props that do not match the kind", async () => {
    const { outbox, store } = setup();

    await expect(
      outbox.enqueue(teamInviteEmail, { ...invite, acceptUrl: "not a url" }, { email: "g@example.com", userId: null }, "k"),
    ).rejects.toThrow();
    expect(store.deliveries).toHaveLength(0);
  });

  it("adds a signed unsubscribe link and the one-click headers to a notification", async () => {
    const { outbox, store } = setup();

    await outbox.enqueue(generationFinishedEmail, generation, { email: "g@example.com", userId: "user-1" }, "gen:1");

    const row = store.deliveries[0];
    const pageUrl = new URL(generationFinishedEmail.props.parse(row?.props).unsubscribeUrl);
    expect(pageUrl.origin + pageUrl.pathname).toBe("https://doxa.so/email/unsubscribe");
    const query = readUnsubscribeQuery(pageUrl.searchParams);
    expect(query?.target).toEqual({ userId: "user-1", category: "generations" });
    expect(query && (await new UnsubscribeTokens(SECRET).verify(query.target, query.token))).toBe(true);
    expect(row?.headers["List-Unsubscribe"]).toMatch(/^<https:\/\/api\.doxa\.so\/email\/unsubscribe\?/);
    expect(row?.headers["List-Unsubscribe-Post"]).toBe("List-Unsubscribe=One-Click");
  });

  it("skips a notification that the recipient turned off", async () => {
    const { outbox, store } = setup();
    await store.set("user-1", "generations", false);

    expect(await outbox.enqueue(generationFinishedEmail, generation, { email: "g@example.com", userId: "user-1" }, "gen:1")).toBe(
      "opted_out",
    );
    expect(store.deliveries).toHaveLength(0);
  });

  it("needs a recipient user for a notification", async () => {
    const { outbox } = setup();
    await expect(
      outbox.enqueue(generationFinishedEmail, generation, { email: "g@example.com", userId: null }, "gen:1"),
    ).rejects.toThrow(/needs a recipient user/);
  });
});

describe("EmailDeliveryService", () => {
  async function queuedDelivery() {
    const harness = setup();
    await harness.outbox.enqueue(teamInviteEmail, invite, { email: "grace@example.com", userId: null }, "team-invite:1");
    const id = harness.store.deliveries[0]?.id ?? "";
    return { ...harness, id };
  }

  it("lets only one claim win", async () => {
    const { service, id } = await queuedDelivery();

    const first = await service.claim(id);
    expect(first).toMatchObject({ id, kind: "team-invite", attempt: 1, recipientEmail: "grace@example.com" });
    expect(await service.claim(id)).toBeNull();
  });

  it("marks a sent email", async () => {
    const { service, store, id } = await queuedDelivery();
    const claim = await service.claim(id);

    const outcome = await service.record({
      deliveryId: id,
      claimToken: claim?.claimToken ?? "",
      attempt: 1,
      result: emailSent("cloudflare", "cf-1"),
    });

    expect(outcome).toEqual({ retryAfterSeconds: null });
    expect(store.deliveries[0]).toMatchObject({ status: "sent", provider: "cloudflare", providerMessageId: "cf-1" });
  });

  it("puts a retryable failure back in the queue with a delay", async () => {
    const { service, store, id } = await queuedDelivery();
    const claim = await service.claim(id);

    const outcome = await service.record({
      deliveryId: id,
      claimToken: claim?.claimToken ?? "",
      attempt: 1,
      result: emailFailed("cloudflare", "rate_limited", "slow down", "E_RATE_LIMIT_EXCEEDED"),
    });

    expect(outcome).toEqual({ retryAfterSeconds: 60 });
    expect(store.deliveries[0]).toMatchObject({ status: "queued", lastFailureKind: "rate_limited" });
    expect(await service.claim(id)).toMatchObject({ attempt: 2 });
  });

  it("records a provider suppression in the Doxa list", async () => {
    const { service, store, id } = await queuedDelivery();
    const claim = await service.claim(id);

    await service.record({
      deliveryId: id,
      claimToken: claim?.claimToken ?? "",
      attempt: 1,
      result: emailFailed("cloudflare", "recipient_suppressed", "suppressed", "E_RECIPIENT_SUPPRESSED"),
    });

    expect(store.deliveries[0]?.status).toBe("suppressed");
    expect(store.suppressions.get("grace@example.com")).toEqual({ reason: "provider", source: "cloudflare" });
  });

  it("does not send to an address on the Doxa suppression list", async () => {
    const { service, store, id } = await queuedDelivery();
    await store.suppress([{ email: "grace@example.com", reason: "complaint", source: "doxa" }]);

    expect(await service.claim(id)).toBeNull();
    expect(store.deliveries[0]).toMatchObject({ status: "suppressed", provider: "doxa" });
  });

  it("ignores a result whose claim the sweeper took back", async () => {
    const { service, store, sweeper, advance, id } = await queuedDelivery();
    const stale = await service.claim(id);
    advance(EMAIL_SWEEP_LIMITS.sendingTimeoutMs);
    await sweeper.run();
    await service.claim(id);

    const outcome = await service.record({
      deliveryId: id,
      claimToken: stale?.claimToken ?? "",
      attempt: 1,
      result: emailSent("cloudflare", "late"),
    });

    expect(outcome).toEqual({ retryAfterSeconds: null });
    expect(store.deliveries[0]).toMatchObject({ status: "sending", attempts: 2 });
  });
});

describe("EmailDeliverySweeper", () => {
  it("sends stale queued rows to the queue again and leaves fresh ones", async () => {
    const { outbox, sweeper, queue, store, advance } = setup();
    queue.failNext();
    await outbox.enqueue(teamInviteEmail, invite, { email: "a@example.com", userId: null }, "k1");

    expect(await sweeper.run()).toBe(0);
    advance(EMAIL_SWEEP_LIMITS.queuedGraceMs);
    expect(await sweeper.run()).toBe(1);
    expect(queue.messages).toEqual([{ deliveryId: store.deliveries[0]?.id }]);
  });

  it("does not resend a row that waits for a scheduled retry", async () => {
    const { outbox, sweeper, service, store, advance } = setup();
    await outbox.enqueue(teamInviteEmail, invite, { email: "a@example.com", userId: null }, "k1");
    const id = store.deliveries[0]?.id ?? "";
    const claim = await service.claim(id);
    await service.record({
      deliveryId: id,
      claimToken: claim?.claimToken ?? "",
      attempt: 1,
      result: emailFailed("cloudflare", "quota_exceeded", "quota"),
    });

    advance(EMAIL_SWEEP_LIMITS.queuedGraceMs);
    expect(await sweeper.run()).toBe(0);
  });
});
