import { describe, expect, test, vi } from "vitest";
import { emailPreferencesSchema, emailUnsubscribeResultSchema } from "@doxahq/contracts/email-preferences";
import { UnsubscribeTokens } from "@doxahq/email";
import { createApiRouter } from "../../src/http/app";
import { EmailPreferencesService } from "../../src/services/email/email-preferences-service";
import { InMemoryEmailStore } from "../support/in-memory-email-store";

const session = vi.hoisted(() => ({ userId: "user-1" }));
vi.mock("../../src/http/auth", () => ({
  withUser: (_context: unknown, handler: (userId: string) => Promise<Response>) => handler(session.userId),
}));

const { createEmailPreferencesRoutes, createEmailUnsubscribeRoutes } = await import("../../src/routes/email");

const tokens = new UnsubscribeTokens("x".repeat(32));

function setup() {
  const store = new InMemoryEmailStore();
  const service = new EmailPreferencesService({ store, unsubscribe: tokens, now: () => new Date() });
  const app = createApiRouter();
  app.route("/email-preferences", createEmailPreferencesRoutes(() => service));
  app.route("/email", createEmailUnsubscribeRoutes(() => service));
  const send = (path: string, method = "GET", body?: unknown) =>
    app.request(
      `https://api.doxa.so${path}`,
      {
        method,
        headers: body === undefined ? {} : { "content-type": "application/json" },
        body: body === undefined ? undefined : JSON.stringify(body),
      },
      { WEB_ORIGIN: "https://doxa.so" },
    );
  return { store, send };
}

async function unsubscribePath(userId: string, category: "approvals" | "generations" | "domains") {
  const url = new URL(await tokens.urlFor("https://api.doxa.so/email/unsubscribe", { userId, category }));
  return `${url.pathname}${url.search}`;
}

describe("email preferences", () => {
  test("lists every category as on, then turns one off", async () => {
    const env = setup();
    const initial = emailPreferencesSchema.parse(await (await env.send("/email-preferences")).json());
    expect(initial.preferences.every((preference) => preference.enabled)).toBe(true);

    const updated = await env.send("/email-preferences", "PUT", { category: "generations", enabled: false });
    expect(emailPreferencesSchema.parse(await updated.json()).preferences).toContainEqual({
      category: "generations",
      enabled: false,
    });
    expect((await env.send("/email-preferences", "PUT", { category: "marketing", enabled: false })).status).toBe(400);
  });
});

describe("one-click unsubscribe", () => {
  test("a signed link turns off its category without a session", async () => {
    const env = setup();
    const response = await env.send(await unsubscribePath("user-2", "approvals"), "POST");

    expect(response.status).toBe(200);
    expect(emailUnsubscribeResultSchema.parse(await response.json())).toEqual({ category: "approvals", unsubscribed: true });
    expect(await env.store.disabledCategories("user-2")).toEqual(new Set(["approvals"]));
  });

  test("a link signed for another user is refused", async () => {
    const env = setup();
    const path = (await unsubscribePath("user-2", "approvals")).replace("user=user-2", "user=user-3");

    const response = await env.send(path, "POST");
    expect(response.status).toBe(400);
    expect(await response.json()).toMatchObject({ error: { details: { code: "invalid_unsubscribe_link" } } });
    expect(await env.store.disabledCategories("user-3")).toEqual(new Set());
  });

  test("opening the link sends the person to the confirmation page and changes nothing", async () => {
    const env = setup();
    const path = await unsubscribePath("user-2", "domains");

    const response = await env.send(path);
    expect(response.status).toBe(302);
    expect(response.headers.get("location")).toBe(`https://doxa.so/email/unsubscribe${path.slice(path.indexOf("?"))}`);
    expect(await env.store.disabledCategories("user-2")).toEqual(new Set());
  });
});
