import { describe, expect, it } from "vitest";
import type { ProjectDto } from "@doxahq/contracts";
import { ROLE_CAPABILITIES, TEAM_ROLES, type TeamRole } from "@doxahq/contracts/teams";
import {
  InMemoryProjectAccess,
  membershipPolicy,
} from "../../support/in-memory-project-access";
import type { OAuthScope, ProjectScopeClaim } from "@doxahq/contracts/agent-access";
import {
  agentActor,
  dashboardActor,
  toProjectId,
  toUserId,
  type Actor,
} from "../../../src/services/agent-access/actor";
import {
  CAPABILITIES,
  type Capability,
} from "../../../src/services/agent-access/capabilities";
import { MembershipProjectAccessPolicy } from "../../../src/services/agent-access/membership-project-access-policy";
import {
  decideProjectAccess,
  effectiveCapabilities,
  isProjectInScope,
} from "../../../src/services/agent-access/project-access-policy";

const OWNER = "owner-user";
const OTHER = "other-user";
const PROJECT_A = "11111111-1111-4111-8111-111111111111";
const PROJECT_B = "33333333-3333-4333-8333-333333333333";
const MISSING = "44444444-4444-4444-8444-444444444444";
const ALL_CAPABILITIES: ReadonlySet<Capability> = new Set(CAPABILITIES);

function agent(
  userId: string,
  scopes: OAuthScope[],
  projectScope: ProjectScopeClaim = { kind: "all" },
): Actor {
  return agentActor({
    userId,
    clientId: "client-1",
    clientName: "Claude Code",
    grantRef: "22222222-2222-4222-8222-222222222222",
    scopes,
    projectScope,
  });
}

function ownerPolicy(owners: Record<string, string>): MembershipProjectAccessPolicy {
  return membershipPolicy(
    Object.fromEntries(Object.entries(owners).map(([id, owner]) => [id, { owner }])),
  );
}

const sorted = (set: ReadonlySet<string>) => [...set].sort();

describe("isProjectInScope", () => {
  it.each([
    [{ kind: "all" } as const, PROJECT_A, true],
    [{ kind: "selected", projectIds: new Set([toProjectId(PROJECT_A)]) } as const, PROJECT_A, true],
    [{ kind: "selected", projectIds: new Set([toProjectId(PROJECT_A)]) } as const, PROJECT_B, false],
  ])("scope %j contains %s: %s", (scope, projectId, expected) => {
    expect(isProjectInScope(scope, toProjectId(projectId))).toBe(expected);
  });
});

describe("effectiveCapabilities", () => {
  const projectA = toProjectId(PROJECT_A);

  it("gives the dashboard actor every role capability", () => {
    expect(
      sorted(effectiveCapabilities(ALL_CAPABILITIES, dashboardActor(OWNER), projectA)),
    ).toEqual([...CAPABILITIES].sort());
  });

  it.each<[OAuthScope, Capability[]]>([
    ["projects:read", ["domains.read", "generation.read", "project.read"]],
    ["projects:write", ["domains.read", "generation.read", "project.create", "project.delete", "project.read"]],
    ["docs:read", ["docs.read"]],
    ["docs:write", ["docs.read", "docs.write"]],
    ["site:write", ["docs.read", "site.write"]],
    ["domains:write", ["domains.read", "domains.write", "generation.read", "project.read"]],
    ["publish", ["docs.publish", "docs.read", "docs.restore"]],
    ["generation:run", ["domains.read", "generation.read", "generation.run", "project.read"]],
  ])("narrows an agent with %s", (scope, expected) => {
    expect(
      sorted(effectiveCapabilities(ALL_CAPABILITIES, agent(OWNER, [scope]), projectA)),
    ).toEqual(expected.sort());
  });

  it("intersects with the role, never widens it", () => {
    const role: ReadonlySet<Capability> = new Set(["docs.read"]);
    expect(
      sorted(effectiveCapabilities(role, agent(OWNER, ["docs:write"]), projectA)),
    ).toEqual(["docs.read"]);
  });

  it("gives nothing for a project outside the grant", () => {
    const actor = agent(OWNER, ["docs:write"], {
      kind: "selected",
      projectIds: [PROJECT_B],
    });
    expect(effectiveCapabilities(ALL_CAPABILITIES, actor, projectA).size).toBe(0);
  });

  it("keeps capabilities for a project inside the grant", () => {
    const actor = agent(OWNER, ["docs:read"], {
      kind: "selected",
      projectIds: [PROJECT_A],
    });
    expect(sorted(effectiveCapabilities(ALL_CAPABILITIES, actor, projectA))).toEqual([
      "docs.read",
    ]);
  });

  it("never gives an agent approvals.decide", () => {
    const actor = agent(OWNER, [
      "projects:write",
      "docs:write",
      "site:write",
      "domains:write",
      "publish",
      "generation:run",
    ]);
    expect(
      effectiveCapabilities(ALL_CAPABILITIES, actor, projectA).has("approvals.decide"),
    ).toBe(false);
  });
});

describe("decideProjectAccess", () => {
  it("returns forbidden when the role lacks the capability", () => {
    const decision = decideProjectAccess(
      {
        projectId: toProjectId(PROJECT_A),
        ownerUserId: toUserId(OWNER),
        role: "viewer",
        capabilities: new Set(["docs.read"]),
      },
      dashboardActor(OTHER),
      "docs.publish",
    );
    expect(decision).toEqual({ allowed: false, reason: "forbidden" });
  });

  it("returns not_found to an agent whose role lacks the capability (spec §12 q3)", () => {
    const decision = decideProjectAccess(
      {
        projectId: toProjectId(PROJECT_A),
        ownerUserId: toUserId(OWNER),
        role: "viewer",
        capabilities: new Set(["docs.read"]),
      },
      agent(OTHER, ["publish"]),
      "docs.publish",
    );
    expect(decision).toEqual({ allowed: false, reason: "not_found" });
  });
});

describe("MembershipProjectAccessPolicy.authorize on personal projects (v1 owner policy)", () => {
  const policy = ownerPolicy({ [PROJECT_A]: OWNER, [PROJECT_B]: OTHER });
  const onlyA: ProjectScopeClaim = { kind: "selected", projectIds: [PROJECT_A] };
  const onlyB: ProjectScopeClaim = { kind: "selected", projectIds: [PROJECT_B] };

  it.each<[string, Actor, string, Capability, string]>([
    ["owner on dashboard", dashboardActor(OWNER), PROJECT_A, "approvals.decide", "allowed"],
    ["non-owner on dashboard", dashboardActor(OWNER), PROJECT_B, "project.read", "not_found"],
    ["missing project", dashboardActor(OWNER), MISSING, "project.read", "not_found"],
    ["malformed project id", dashboardActor(OWNER), "not-a-uuid", "project.read", "not_found"],
    ["agent with scope", agent(OWNER, ["publish"]), PROJECT_A, "docs.publish", "allowed"],
    ["agent with implied scope", agent(OWNER, ["publish"]), PROJECT_A, "docs.read", "allowed"],
    ["agent without scope", agent(OWNER, ["docs:read"]), PROJECT_A, "docs.write", "scope_missing"],
    ["agent asking approvals.decide", agent(OWNER, ["publish"]), PROJECT_A, "approvals.decide", "scope_missing"],
    ["agent inside grant", agent(OWNER, ["docs:read"], onlyA), PROJECT_A, "docs.read", "allowed"],
    ["agent outside grant", agent(OWNER, ["docs:read"], onlyB), PROJECT_A, "docs.read", "project_not_in_grant"],
    ["agent outside grant and scope", agent(OWNER, [], onlyB), PROJECT_A, "docs.write", "project_not_in_grant"],
    ["agent on another user's project in grant", agent(OWNER, ["docs:read"], onlyB), PROJECT_B, "docs.read", "not_found"],
  ])("%s", async (_, actor, projectId, capability, expected) => {
    const decision = await policy.authorize(actor, projectId, capability);
    expect(decision.allowed ? "allowed" : decision.reason).toBe(expected);
  });

  it("returns the authorized project with effective capabilities", async () => {
    const decision = await policy.authorize(
      agent(OWNER, ["docs:write"]),
      PROJECT_A,
      "docs.write",
    );
    expect(decision.allowed).toBe(true);
    if (!decision.allowed) return;
    expect(decision.project.projectId).toBe(PROJECT_A);
    expect(decision.project.ownerUserId).toBe(OWNER);
    expect(sorted(decision.project.capabilities)).toEqual(["docs.read", "docs.write"]);
  });
});

describe("MembershipProjectAccessPolicy.listAccessibleProjects", () => {
  const policy = ownerPolicy({ [PROJECT_A]: OWNER, [PROJECT_B]: OWNER, [MISSING]: OTHER });
  const ids = (projects: ProjectDto[]) => projects.map((p) => p.id).sort();

  it.each<[string, Actor, string[]]>([
    ["dashboard owner", dashboardActor(OWNER), [PROJECT_A, PROJECT_B]],
    ["agent with all projects", agent(OWNER, ["projects:read"]), [PROJECT_A, PROJECT_B]],
    [
      "agent with selected projects",
      agent(OWNER, ["projects:read"], { kind: "selected", projectIds: [PROJECT_B, MISSING] }),
      [PROJECT_B],
    ],
    ["user with no projects", dashboardActor("nobody"), []],
  ])("%s", async (_, actor, expected) => {
    expect(ids(await policy.listAccessibleProjects(actor))).toEqual(expected.sort());
  });
});

const TEAM = "55555555-5555-4555-8555-555555555555";
const TEAM_PROJECT = "66666666-6666-4666-8666-666666666666";
const MEMBER = "member-user";

/** v2 spec §5, the role table as written in the spec. */
const SPEC_ROLE_TABLE: Record<TeamRole, readonly Capability[]> = {
  owner: [
    "project.read", "docs.read", "docs.write", "site.write", "docs.publish", "docs.restore",
    "approvals.decide", "generation.run", "domains.write", "approvals.configure", "team.manage",
    "project.delete", "team.delete",
  ],
  admin: [
    "project.read", "docs.read", "docs.write", "site.write", "docs.publish", "docs.restore",
    "approvals.decide", "generation.run", "domains.write", "approvals.configure", "team.manage",
  ],
  editor: ["project.read", "docs.read", "docs.write", "site.write", "docs.publish", "docs.restore", "approvals.decide"],
  viewer: ["project.read", "docs.read"],
};

/** Capabilities the spec table does not list. They follow `project.read` (read) or the admin rule. */
const READ_FOLLOWERS: readonly Capability[] = ["domains.read", "generation.read"];

function expectedAllowed(role: TeamRole, capability: Capability): boolean {
  if (READ_FOLLOWERS.includes(capability)) return true;
  if (capability === "project.create") return role === "owner" || role === "admin";
  return SPEC_ROLE_TABLE[role].includes(capability);
}

function teamPolicy(role: TeamRole | null) {
  const store = new InMemoryProjectAccess(
    { [TEAM_PROJECT]: { owner: OWNER, teamId: TEAM } },
    { [TEAM]: { [OWNER]: "owner", ...(role === null ? {} : { [MEMBER]: role }) } },
  );
  return { store, policy: new MembershipProjectAccessPolicy(store) };
}

describe("team role matrix (spec §5)", () => {
  const cases = TEAM_ROLES.flatMap((role) => CAPABILITIES.map((capability) => [role, capability] as const));

  it.each(cases)("%s on the dashboard: %s", async (role, capability) => {
    const { policy } = teamPolicy(role);
    const decision = await policy.authorize(dashboardActor(MEMBER), TEAM_PROJECT, capability);
    const expected = expectedAllowed(role, capability) ? "allowed" : "forbidden";
    expect(decision.allowed ? "allowed" : decision.reason).toBe(expected);
  });

  it("matches the role table in the contracts", () => {
    for (const role of TEAM_ROLES) {
      const fromContracts = CAPABILITIES.filter((capability) => ROLE_CAPABILITIES[role].has(capability));
      expect(fromContracts).toEqual(CAPABILITIES.filter((capability) => expectedAllowed(role, capability)));
    }
  });

  it("returns the member's role and the project owner on the authorized project", async () => {
    const { policy } = teamPolicy("editor");
    const decision = await policy.authorize(dashboardActor(MEMBER), TEAM_PROJECT, "docs.write");
    expect(decision.allowed).toBe(true);
    if (!decision.allowed) return;
    expect(decision.project.role).toBe("editor");
    // Storage, billing and GitHub stay with the project owner.
    expect(decision.project.ownerUserId).toBe(OWNER);
  });
});

describe("team project access", () => {
  it("gives a non-member not_found for every capability", async () => {
    const { policy } = teamPolicy(null);
    for (const capability of CAPABILITIES) {
      const decision = await policy.authorize(dashboardActor(MEMBER), TEAM_PROJECT, capability);
      expect(decision).toEqual({ allowed: false, reason: "not_found" });
    }
  });

  it("empties a member's capabilities at once when they leave", async () => {
    const { store, policy } = teamPolicy("admin");
    expect((await policy.authorize(dashboardActor(MEMBER), TEAM_PROJECT, "docs.read")).allowed).toBe(true);
    store.leave(TEAM, MEMBER);
    expect(await policy.authorize(dashboardActor(MEMBER), TEAM_PROJECT, "docs.read")).toEqual({
      allowed: false,
      reason: "not_found",
    });
    expect(await policy.authorize(dashboardActor(MEMBER), TEAM_PROJECT, "project.read")).toEqual({
      allowed: false,
      reason: "not_found",
    });
  });

  it("keeps a member's agent grant, but every call returns not_found after they leave", async () => {
    const { store, policy } = teamPolicy("editor");
    const memberAgent = agent(MEMBER, ["docs:write"]);
    expect((await policy.authorize(memberAgent, TEAM_PROJECT, "docs.write")).allowed).toBe(true);
    store.leave(TEAM, MEMBER);
    expect(await policy.authorize(memberAgent, TEAM_PROJECT, "docs.read")).toEqual({
      allowed: false,
      reason: "not_found",
    });
    expect(await policy.listAccessibleProjects(memberAgent)).toEqual([]);
  });

  it("lets a viewer's agent read, and answers not_found to its writes (spec §12 q3)", async () => {
    const { policy } = teamPolicy("viewer");
    const viewerAgent = agent(MEMBER, ["docs:write", "publish", "site:write"]);
    expect((await policy.authorize(viewerAgent, TEAM_PROJECT, "docs.read")).allowed).toBe(true);
    for (const capability of ["docs.write", "site.write", "docs.publish", "docs.restore"] as const) {
      expect(await policy.authorize(viewerAgent, TEAM_PROJECT, capability)).toEqual({
        allowed: false,
        reason: "not_found",
      });
    }
  });

  it("does not give a project owner access to their project in a team they left", async () => {
    const store = new InMemoryProjectAccess(
      { [TEAM_PROJECT]: { owner: OWNER, teamId: TEAM } },
      { [TEAM]: { [MEMBER]: "owner" } },
    );
    const policy = new MembershipProjectAccessPolicy(store);
    expect(await policy.authorize(dashboardActor(OWNER), TEAM_PROJECT, "project.read")).toEqual({
      allowed: false,
      reason: "not_found",
    });
  });

  it("keeps the owner's existing grants working after the project moves into their team", async () => {
    const store = new InMemoryProjectAccess({ [PROJECT_A]: { owner: OWNER } });
    const policy = new MembershipProjectAccessPolicy(store);
    const grant = agent(OWNER, ["docs:write", "publish"], { kind: "selected", projectIds: [PROJECT_A] });
    expect((await policy.authorize(grant, PROJECT_A, "docs.publish")).allowed).toBe(true);
    store.join(TEAM, OWNER, "owner");
    store.moveToTeam(PROJECT_A, TEAM);
    expect((await policy.authorize(grant, PROJECT_A, "docs.write")).allowed).toBe(true);
    expect((await policy.authorize(grant, PROJECT_A, "docs.publish")).allowed).toBe(true);
    expect((await policy.listAccessibleProjects(grant)).map((project) => project.id)).toEqual([PROJECT_A]);
  });

  it("lists personal projects and team projects, with the team", async () => {
    const store = new InMemoryProjectAccess(
      {
        [PROJECT_A]: { owner: MEMBER },
        [PROJECT_B]: { owner: OTHER },
        [TEAM_PROJECT]: { owner: OTHER, teamId: TEAM },
      },
      { [TEAM]: { [OTHER]: "owner", [MEMBER]: "viewer" } },
    );
    const policy = new MembershipProjectAccessPolicy(store);
    const listed = await policy.listAccessibleProjects(dashboardActor(MEMBER));
    const byId = (projects: ProjectDto[]) => projects.map((p) => [p.id, p.team?.id ?? null]).sort();
    expect(byId(listed)).toEqual([[PROJECT_A, null], [TEAM_PROJECT, TEAM]].sort());
  });
});

