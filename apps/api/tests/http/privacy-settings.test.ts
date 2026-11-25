import { describe, expect, test, vi } from "vitest";
import { privacySettingsSchema } from "@doxahq/contracts/privacy-settings";
import { createApiRouter } from "../../src/http/app";
import { PrivacySettingsService } from "../../src/services/privacy/privacy-settings-service";
import { InMemoryPrivacySettings } from "../support/in-memory-privacy-settings";

const session = vi.hoisted(() => ({ userId: "user-1" }));
vi.mock("../../src/http/auth", () => ({
  withUser: (_context: unknown, handler: (userId: string) => Promise<Response>) => handler(session.userId),
}));

const { createPrivacySettingsRoutes } = await import("../../src/routes/privacy-settings");

const NOW = new Date("2026-11-25T12:00:00Z");

function setup() {
  const store = new InMemoryPrivacySettings();
  const changes: Array<{ userId: string; productAnalytics: boolean }> = [];
  const service = new PrivacySettingsService({
    store,
    now: () => NOW,
    onChange: (userId, settings) => changes.push({ userId, ...settings }),
  });
  const app = createApiRouter();
  app.route("/privacy-settings", createPrivacySettingsRoutes(() => service));
  const send = (method = "GET", body?: unknown) =>
    app.request(
      "https://api.doxa.so/privacy-settings",
      {
        method,
        headers: body === undefined ? {} : { "content-type": "application/json" },
        body: body === undefined ? undefined : JSON.stringify(body),
      },
      { WEB_ORIGIN: "https://doxa.so" },
    );
  return { store, changes, send };
}

describe("privacy settings", () => {
  test("product analytics is on for a person without a row", async () => {
    const env = setup();
    const response = await env.send();

    expect(response.status).toBe(200);
    expect(privacySettingsSchema.parse(await response.json())).toEqual({ productAnalytics: true });
    expect(env.store.rows.size).toBe(0);
  });

  test("turns product analytics off, stores it and tells the process", async () => {
    const env = setup();
    const updated = await env.send("PUT", { productAnalytics: false });

    expect(privacySettingsSchema.parse(await updated.json())).toEqual({ productAnalytics: false });
    expect(env.store.rows.get("user-1")).toEqual({ productAnalytics: false, updatedAt: NOW });
    expect(env.changes).toEqual([{ userId: "user-1", productAnalytics: false }]);
    expect(privacySettingsSchema.parse(await (await env.send()).json())).toEqual({ productAnalytics: false });
  });

  test("refuses a body that is not the contract", async () => {
    const env = setup();
    for (const body of [{ productAnalytics: "no" }, { productAnalytics: false, sessionReplay: false }, {}]) {
      expect((await env.send("PUT", body)).status).toBe(400);
    }
    expect(env.store.rows.size).toBe(0);
    expect(env.changes).toEqual([]);
  });
});
