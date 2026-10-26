import { DEFAULT_DOXABOT_INSTRUCTIONS, doxabotInstructionsStateSchema } from "@doxahq/contracts";
import { roleHasCapability, type TeamRole } from "@doxahq/contracts/teams";
import { describe, expect, test, vi } from "vitest";
import { createApiRouter, type ApiContext } from "../../src/http/app";
import type { DashboardProjectAccess } from "../../src/http/project-access";
import type { Capability } from "../../src/services/agent-access/capabilities";
import { DoxabotInstructionsService } from "../../src/services/doxabot/instructions";
import { InMemoryProjectInstructionsStore } from "../support/in-memory-project-instructions";

const PROJECT = "11111111-1111-4111-8111-111111111111";
const session = vi.hoisted(() => ({ role: "owner" as TeamRole | null }));

// The real policy is covered by the role matrix tests; here the route only
// needs to ask for the right capability.
vi.mock("../../src/http/project-access", () => ({
  withProjectAccess: async (
    _context: ApiContext,
    capability: Capability,
    handler: (access: DashboardProjectAccess) => Promise<Response>,
  ) => {
    if (session.role === null) return Response.json({ error: { message: "Not found" } }, { status: 404 });
    if (!roleHasCapability(session.role, capability)) {
      return Response.json({ error: { message: "Forbidden", details: { code: "forbidden" } } }, { status: 403 });
    }
    return handler({
      actorUserId: "user-1",
      projectId: PROJECT,
      ownerUserId: "owner-1",
      role: session.role,
      capabilities: new Set(),
    });
  },
}));
vi.mock("cloudflare:workers", () => ({ WorkerEntrypoint: class {} }));

import { createDoxabotInstructionsRoutes } from "../../src/routes/doxabot-instructions";

const PATH = `/projects/${PROJECT}/doxabot/instructions`;

function setup(role: TeamRole | null) {
  session.role = role;
  const service = new DoxabotInstructionsService(new InMemoryProjectInstructionsStore());
  const app = createApiRouter();
  app.route("/projects/:projectId/doxabot/instructions", createDoxabotInstructionsRoutes(() => service));
  return app;
}

const send = (method: string, body: unknown) => ({ method, body: JSON.stringify(body) });

describe("Doxabot instructions routes", () => {
  test("an editor reads the instructions", async () => {
    const response = await setup("editor").request(PATH);

    expect(response.status).toBe(200);
    expect(doxabotInstructionsStateSchema.parse(await response.json())).toEqual({ current: null, history: [] });
  });

  test("an editor cannot save instructions", async () => {
    const response = await setup("editor").request(
      PATH,
      send("PUT", { instructions: DEFAULT_DOXABOT_INSTRUCTIONS, baseVersion: null }),
    );

    expect(response.status).toBe(403);
  });

  test("an admin saves, then a stale save answers 409", async () => {
    const app = setup("admin");
    const body = { instructions: DEFAULT_DOXABOT_INSTRUCTIONS, baseVersion: null };

    const first = await app.request(PATH, send("PUT", body));
    const second = await app.request(PATH, send("PUT", body));

    expect(first.status).toBe(200);
    expect(doxabotInstructionsStateSchema.parse(await first.json()).current?.version).toBe(1);
    expect(second.status).toBe(409);
    expect(await second.json()).toMatchObject({ error: { details: { code: "stale_version" } } });
  });

  test("an invalid body answers 400", async () => {
    const response = await setup("owner").request(
      PATH,
      send("PUT", { instructions: { ...DEFAULT_DOXABOT_INSTRUCTIONS, rules: ["x".repeat(201)] }, baseVersion: null }),
    );

    expect(response.status).toBe(400);
  });

  test("a restore of an unknown version answers 404", async () => {
    const response = await setup("owner").request(`${PATH}/restore`, send("POST", { version: 3, baseVersion: null }));

    expect(response.status).toBe(404);
    expect(await response.json()).toMatchObject({ error: { details: { code: "version_not_found" } } });
  });
});
