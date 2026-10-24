import { describe, expect, it } from "vitest";
import {
  MAX_GRANT_PROJECT_IDS,
  OAUTH_SCOPES,
  OAUTH_SCOPE_IMPLICATIONS,
  agentGrantPropsSchema,
  isOAuthScope,
  projectScopeClaimSchema,
} from "@doxahq/contracts/agent-access";

const uuid = (n: number) =>
  `00000000-0000-4000-8000-${n.toString().padStart(12, "0")}`;

const validProps = {
  version: 1,
  grantRef: uuid(1),
  userId: "user-1",
  clientName: "Claude Code",
  projectScope: { kind: "all" },
};

describe("isOAuthScope", () => {
  it.each(OAUTH_SCOPES)("accepts %s", (scope) => {
    expect(isOAuthScope(scope)).toBe(true);
  });

  it.each(["", "admin", "docs", "DOCS:READ", "docs:read "])(
    "rejects %j",
    (value) => {
      expect(isOAuthScope(value)).toBe(false);
    },
  );
});

describe("OAUTH_SCOPE_IMPLICATIONS", () => {
  it("only implies read scopes", () => {
    const implied = Object.values(OAUTH_SCOPE_IMPLICATIONS).flat();
    expect([...new Set(implied)].sort()).toEqual(["docs:read", "projects:read"]);
  });
});

describe("projectScopeClaimSchema", () => {
  it.each([
    { kind: "all" },
    { kind: "selected", projectIds: [uuid(1)] },
    {
      kind: "selected",
      projectIds: Array.from({ length: MAX_GRANT_PROJECT_IDS }, (_, i) => uuid(i)),
    },
  ])("accepts %j", (claim) => {
    expect(projectScopeClaimSchema.safeParse(claim).success).toBe(true);
  });

  it.each([
    ["no kind", {}],
    ["unknown kind", { kind: "some" }],
    ["empty selection", { kind: "selected", projectIds: [] }],
    ["non-uuid id", { kind: "selected", projectIds: ["project-1"] }],
    ["duplicate ids", { kind: "selected", projectIds: [uuid(1), uuid(1)] }],
    [
      "too many ids",
      {
        kind: "selected",
        projectIds: Array.from({ length: MAX_GRANT_PROJECT_IDS + 1 }, (_, i) => uuid(i)),
      },
    ],
    ["extra key on all", { kind: "all", projectIds: [uuid(1)] }],
    ["extra key on selected", { kind: "selected", projectIds: [uuid(1)], x: 1 }],
  ])("rejects %s", (_, claim) => {
    expect(projectScopeClaimSchema.safeParse(claim).success).toBe(false);
  });
});

describe("agentGrantPropsSchema", () => {
  it("accepts valid props", () => {
    expect(agentGrantPropsSchema.parse(validProps)).toEqual(validProps);
  });

  it.each([
    ["unknown version", { ...validProps, version: 2 }],
    ["missing version", { ...validProps, version: undefined }],
    ["non-uuid grantRef", { ...validProps, grantRef: "grant-1" }],
    ["empty userId", { ...validProps, userId: "" }],
    ["empty clientName", { ...validProps, clientName: "" }],
    ["long clientName", { ...validProps, clientName: "x".repeat(201) }],
    ["bad projectScope", { ...validProps, projectScope: { kind: "selected", projectIds: [] } }],
    ["extra key", { ...validProps, email: "a@example.com" }],
  ])("rejects %s", (_, props) => {
    expect(agentGrantPropsSchema.safeParse(props).success).toBe(false);
  });
});
