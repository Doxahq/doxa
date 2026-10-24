import { describe, expect, it, vi } from "vitest";

vi.mock("cloudflare:workers", () => ({ WorkerEntrypoint: class {} }));

const { withParsedProps } = await import("../../../src/services/oauth/token-validator");
const { GRANT_REF, MCP_RESOURCE, OWNER } = await import("./fixtures");

const validated = {
  audience: MCP_RESOURCE,
  expiresAt: 1_900_000_000,
  scope: ["docs:read"],
  userId: OWNER,
  clientId: "client-abc",
};

const props = {
  version: 1,
  grantRef: GRANT_REF,
  userId: OWNER,
  clientName: "Claude Code",
  projectScope: { kind: "all" },
};

describe("withParsedProps", () => {
  it("keeps a token whose props match the schema", () => {
    expect(withParsedProps({ ...validated, props })).toEqual({ ...validated, props });
  });

  it.each([
    ["an unknown props version", { ...props, version: 2 }],
    ["missing props", undefined],
    ["an extra field", { ...props, email: "user@doxa.so" }],
  ])("treats %s as an invalid token", (_label, value) => {
    expect(withParsedProps({ ...validated, props: value })).toBeNull();
  });
});
