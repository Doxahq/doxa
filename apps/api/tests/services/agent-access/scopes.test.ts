import { describe, expect, it } from "vitest";
import { OAUTH_SCOPES, type OAuthScope } from "@doxahq/contracts/agent-access";
import { CAPABILITIES } from "../../../src/services/agent-access/capabilities";
import {
  SCOPE_CAPABILITIES,
  capabilitiesForScopes,
  expandScopes,
} from "../../../src/services/agent-access/scopes";

describe("expandScopes", () => {
  it.each<[OAuthScope, OAuthScope[]]>([
    ["projects:read", ["projects:read"]],
    ["projects:write", ["projects:write", "projects:read"]],
    ["docs:read", ["docs:read"]],
    ["docs:write", ["docs:write", "docs:read"]],
    ["site:write", ["site:write", "docs:read"]],
    ["domains:write", ["domains:write", "projects:read"]],
    ["publish", ["publish", "docs:read"]],
    ["generation:run", ["generation:run", "projects:read"]],
  ])("expands %s", (scope, expected) => {
    expect([...expandScopes([scope])].sort()).toEqual([...expected].sort());
  });

  it("covers every scope in the table", () => {
    expect(OAUTH_SCOPES).toHaveLength(8);
  });

  it.each<[OAuthScope, OAuthScope[]]>([
    ["projects:read", ["projects:write", "domains:write", "generation:run"]],
    ["docs:read", ["docs:write", "site:write", "publish"]],
  ])("never implies a write scope from %s", (scope, writes) => {
    const expanded = expandScopes([scope]);
    for (const write of writes) expect(expanded.has(write)).toBe(false);
  });

  it("returns an empty set for no scopes", () => {
    expect(expandScopes([]).size).toBe(0);
  });

  it("merges implications of several scopes without duplicates", () => {
    expect([...expandScopes(["docs:write", "publish", "docs:read"])].sort())
      .toEqual(["docs:read", "docs:write", "publish"]);
  });
});

describe("SCOPE_CAPABILITIES", () => {
  it.each([
    ["projects:read", ["project.read", "domains.read", "generation.read"]],
    ["projects:write", ["project.create", "project.delete"]],
    ["docs:read", ["docs.read"]],
    ["docs:write", ["docs.write"]],
    ["site:write", ["site.write"]],
    ["domains:write", ["domains.write"]],
    ["publish", ["docs.publish", "docs.restore"]],
    ["generation:run", ["generation.run"]],
  ] as const)("maps %s", (scope, capabilities) => {
    expect([...capabilitiesForScopes([scope])].sort()).toEqual(
      [...capabilities].sort(),
    );
  });

  it("never grants approvals.decide", () => {
    expect(capabilitiesForScopes(OAUTH_SCOPES).has("approvals.decide")).toBe(
      false,
    );
  });

  it("never grants approvals.configure", () => {
    expect(capabilitiesForScopes(OAUTH_SCOPES).has("approvals.configure")).toBe(
      false,
    );
  });

  it("never grants instructions.configure", () => {
    expect(capabilitiesForScopes(OAUTH_SCOPES).has("instructions.configure")).toBe(
      false,
    );
  });

  it("grants every other capability through some scope", () => {
    const granted = capabilitiesForScopes(OAUTH_SCOPES);
    expect(CAPABILITIES.filter((c) => !granted.has(c))).toEqual([
      "approvals.decide",
      "approvals.configure",
      "instructions.configure",
      "team.manage",
      "team.delete",
      "billing.read",
      "billing.manage",
    ]);
  });

  it("does not add implied capabilities by itself", () => {
    expect(capabilitiesForScopes(["docs:write"]).has("docs.read")).toBe(false);
    expect(
      capabilitiesForScopes(expandScopes(["docs:write"])).has("docs.read"),
    ).toBe(true);
  });

  it("has an entry for every scope", () => {
    expect(Object.keys(SCOPE_CAPABILITIES).sort()).toEqual(
      [...OAUTH_SCOPES].sort(),
    );
  });
});
