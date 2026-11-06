import { describe, expect, test } from "vitest";
import { isGitHubRateLimited } from "../../src/services/github-rate-limit";

describe("GitHub rate-limit signal", () => {
  test.each([
    ["a retry-after header", new Response("", { status: 403, headers: { "retry-after": "60" } })],
    ["no remaining requests", new Response("", { status: 403, headers: { "x-ratelimit-remaining": "0" } })],
    ["a secondary limit message", new Response(JSON.stringify({ message: "You have exceeded a secondary rate limit." }), { status: 403 })],
  ])("a 403 with %s is a rate limit", async (_name, response) => {
    await expect(isGitHubRateLimited(response)).resolves.toBe(true);
  });

  test.each([
    ["a permission message", new Response(JSON.stringify({ message: "Resource not accessible by integration" }), { status: 403 })],
    ["remaining requests", new Response("", { status: 403, headers: { "x-ratelimit-remaining": "42" } })],
    ["another status", new Response("rate limit", { status: 404 })],
    ["a rate-limit word after the first 1 KB", new Response(`${"x".repeat(2_000)} rate limit`, { status: 403 })],
  ])("a refusal with %s is not a rate limit", async (_name, response) => {
    await expect(isGitHubRateLimited(response)).resolves.toBe(false);
  });
});
