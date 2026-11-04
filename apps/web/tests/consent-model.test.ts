import { OAUTH_SCOPES, type OAuthScope } from "@doxahq/contracts/agent-access"
import { describe, expect, test } from "vitest"

import {
  buildApproveInput,
  effectiveScopes,
  impliedScopes,
  isNavigableRedirect,
  initialProjectChoice,
  initialScopes,
  offeredScopes,
  projectChoiceIssue,
  scopeOptions,
} from "~/lib/oauth/consent-model"

const PROJECT_ID = "6f1c1d2e-3b4a-4c5d-8e9f-0a1b2c3d4e5f"

describe("consent model", () => {
  // SECURITY REGRESSION GUARDRAIL (SEC-013): no write scope is offered unasked.
  test("offers only the read scopes when the client asks for none", () => {
    expect(offeredScopes([])).toEqual(OAUTH_SCOPES.filter((scope) => scope.endsWith(":read")))
  })

  test("checks only the read scopes and selects no project when the page opens", () => {
    expect([...initialScopes(["docs:read", "docs:write", "publish"])]).toEqual(["docs:read"])
    expect(initialProjectChoice(["a", "b"])).toEqual({ kind: "selected", projectIds: new Set() })
    expect(initialProjectChoice(["a"])).toEqual({ kind: "selected", projectIds: new Set(["a"]) })
    expect(initialProjectChoice([])).toEqual({ kind: "all" })
  })

  test("offers the requested scopes in the standard order without duplicates", () => {
    expect(offeredScopes(["publish", "docs:read", "publish"])).toEqual(["docs:read", "publish"])
  })

  test("implied scopes follow the contract implications", () => {
    expect([...impliedScopes(["docs:write", "domains:write"])].sort()).toEqual([
      "docs:read",
      "projects:read",
    ])
    expect(impliedScopes(["docs:read"]).size).toBe(0)
  })

  test("an implied scope shows as checked and required", () => {
    const offered: OAuthScope[] = ["docs:read", "docs:write"]
    const options = scopeOptions(offered, new Set<OAuthScope>(["docs:write"]))

    expect(options).toEqual([
      expect.objectContaining({ scope: "docs:read", checked: true, required: true }),
      expect.objectContaining({ scope: "docs:write", checked: true, required: false }),
    ])
  })

  test("clearing the write scope keeps a read scope the person chose", () => {
    const offered: OAuthScope[] = ["docs:read", "docs:write"]
    expect(effectiveScopes(offered, new Set<OAuthScope>(["docs:read"]))).toEqual(["docs:read"])
  })

  test("does not approve an implied scope the client did not request", () => {
    expect(effectiveScopes(["docs:write"], new Set<OAuthScope>(["docs:write"]))).toEqual(["docs:write"])
  })

  test("selected projects need at least one project", () => {
    expect(projectChoiceIssue({ kind: "all" })).toBeNull()
    expect(projectChoiceIssue({ kind: "selected", projectIds: new Set() })).toBe(
      "Choose at least one project.",
    )
    expect(projectChoiceIssue({ kind: "selected", projectIds: new Set([PROJECT_ID]) })).toBeNull()
  })

  test("builds the approve input only for valid choices", () => {
    const offered: OAuthScope[] = ["docs:read", "docs:write"]

    expect(buildApproveInput(offered, new Set(), { kind: "all" })).toBeNull()
    expect(
      buildApproveInput(offered, new Set<OAuthScope>(["docs:write"]), {
        kind: "selected",
        projectIds: new Set(),
      }),
    ).toBeNull()
    expect(
      buildApproveInput(offered, new Set<OAuthScope>(["docs:write"]), {
        kind: "selected",
        projectIds: new Set([PROJECT_ID]),
      }),
    ).toEqual({
      scopes: ["docs:read", "docs:write"],
      projectScope: { kind: "selected", projectIds: [PROJECT_ID] },
    })
  })

  // SECURITY REGRESSION GUARDRAIL (SEC-034): the browser goes only to the destination the page showed.
  test.each([
    ["http://127.0.0.1:3334/callback?code=abc", "127.0.0.1:3334", true],
    ["https://claude.ai/api/mcp/auth_callback?code=abc", "claude.ai", true],
    ["cursor://anysphere.cursor-mcp/oauth/callback?code=abc", "anysphere.cursor-mcp", true],
    ["com.example.app:/oauth?code=abc", "com.example.app:/oauth", true],
    ["https://evil.example/callback?code=abc", "claude.ai", false],
    ["com.evil.app:/oauth?code=abc", "com.example.app:/oauth", false],
    ["javascript:alert(1)", "javascript:alert(1)", false],
    ["data:text/html,hi", "claude.ai", false],
    ["not a url", "claude.ai", false],
    ["https://claude.ai/callback", "", false],
  ])("isNavigableRedirect(%s, %s) is %s", (value, redirectHost, expected) => {
    expect(isNavigableRedirect(value, redirectHost)).toBe(expected)
  })
})
