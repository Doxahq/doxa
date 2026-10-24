import { describe, expect, it } from "vitest";
import { UnsubscribeTokens, readUnsubscribeQuery, unsubscribeHeaders } from "../src";

const SECRET = "s".repeat(32);
const target = { userId: "user-1", category: "approvals" } as const;

describe("UnsubscribeTokens", () => {
  it("accepts its own token and only for the same user and category", async () => {
    const tokens = new UnsubscribeTokens(SECRET);
    const token = await tokens.tokenFor(target);

    expect(token).toMatch(/^[A-Za-z0-9_-]{43}$/);
    expect(await tokens.verify(target, token)).toBe(true);
    expect(await tokens.verify({ ...target, userId: "user-2" }, token)).toBe(false);
    expect(await tokens.verify({ ...target, category: "domains" }, token)).toBe(false);
    expect(await new UnsubscribeTokens("t".repeat(32)).verify(target, token)).toBe(false);
  });

  it.each(["", "short", "!".repeat(43)])("refuses the malformed token %j", async (token) => {
    expect(await new UnsubscribeTokens(SECRET).verify(target, token)).toBe(false);
  });

  it("refuses a short secret", () => {
    expect(() => new UnsubscribeTokens("short")).toThrow(/at least 32 characters/);
  });

  it("builds a URL that reads back to the same target", async () => {
    const tokens = new UnsubscribeTokens(SECRET);
    const url = new URL(await tokens.urlFor("https://doxa.so/email/unsubscribe", target));
    const query = readUnsubscribeQuery(url.searchParams);

    expect(url.origin + url.pathname).toBe("https://doxa.so/email/unsubscribe");
    expect(query?.target).toEqual(target);
    expect(query && (await tokens.verify(query.target, query.token))).toBe(true);
  });

  it("refuses a query with an unknown category", () => {
    expect(readUnsubscribeQuery(new URLSearchParams({ user: "u", category: "transactional", token: "t" }))).toBeNull();
  });
});

describe("unsubscribeHeaders", () => {
  it("gives the one-click headers", () => {
    expect(unsubscribeHeaders("https://api.doxa.so/email/unsubscribe?x=1")).toEqual({
      "List-Unsubscribe": "<https://api.doxa.so/email/unsubscribe?x=1>",
      "List-Unsubscribe-Post": "List-Unsubscribe=One-Click",
    });
  });
});
