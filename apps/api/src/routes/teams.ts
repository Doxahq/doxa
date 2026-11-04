import {
  createTeamInputSchema,
  createTeamInviteInputSchema,
  moveProjectToTeamInputSchema,
  renameTeamInputSchema,
  updateTeamMemberInputSchema,
  type TeamInviteFailure,
} from "@doxahq/contracts/teams";
import { getWebOrigin } from "../http/access";
import { createApiRouter, type ApiApp, type ApiContext } from "../http/app";
import { withUser } from "../http/auth";
import { error, json, notFound } from "../http/response";
import { parseValidatedJson } from "../http/validation";
import {
  TeamAccessError,
  TeamConflictError,
  TeamInviteError,
  TeamNotFoundError,
} from "../services/teams/errors";
import { TeamService } from "../services/teams/team-service";

export type TeamServiceFactory = (context: ApiContext) => TeamService;

const defaultTeams: TeamServiceFactory = (context) => TeamService.fromEnv(context.env);

/** `/teams`: the signed-in user's teams, members and invite links (v2 spec §5). */
export function createTeamRoutes(teams: TeamServiceFactory = defaultTeams): ApiApp {
  const app = createApiRouter();

  app.get("/", (context) =>
    withTeamUser(context, async (userId) => json({ teams: await teams(context).list(userId) })),
  );

  app.post("/", (context) =>
    withTeamUser(context, async (userId) => {
      const input = await parseValidatedJson(context, createTeamInputSchema, "Invalid team.");
      if (!input.ok) return input.response;
      return json({ team: await teams(context).create(userId, input.data.name) }, { status: 201 });
    }),
  );

  app.get("/:teamId", (context) =>
    withTeamUser(context, async (userId) =>
      json(await teams(context).get(userId, teamIdOf(context), webOriginOf(context))),
    ),
  );

  app.patch("/:teamId", (context) =>
    withTeamUser(context, async (userId) => {
      const input = await parseValidatedJson(context, renameTeamInputSchema, "Invalid team.");
      if (!input.ok) return input.response;
      await teams(context).rename(userId, teamIdOf(context), input.data.name);
      return json(await teams(context).get(userId, teamIdOf(context), webOriginOf(context)));
    }),
  );

  app.delete("/:teamId", (context) =>
    withTeamUser(context, async (userId) => {
      await teams(context).delete(userId, teamIdOf(context));
      return new Response(null, { status: 204 });
    }),
  );

  app.post("/:teamId/invites", (context) =>
    withTeamUser(context, async (userId) => {
      const input = await parseValidatedJson(context, createTeamInviteInputSchema, "Invalid invite.");
      if (!input.ok) return input.response;
      const created = await teams(context).createInvite(userId, teamIdOf(context), input.data, webOriginOf(context));
      return json(created, { status: 201 });
    }),
  );

  app.delete("/:teamId/invites/:inviteId", (context) =>
    withTeamUser(context, async (userId) => {
      await teams(context).revokeInvite(userId, teamIdOf(context), context.req.param("inviteId"));
      return new Response(null, { status: 204 });
    }),
  );

  app.patch("/:teamId/members/:userId", (context) =>
    withTeamUser(context, async (userId) => {
      const input = await parseValidatedJson(context, updateTeamMemberInputSchema, "Invalid role.");
      if (!input.ok) return input.response;
      await teams(context).changeRole(userId, teamIdOf(context), context.req.param("userId"), input.data.role);
      return json(await teams(context).get(userId, teamIdOf(context), webOriginOf(context)));
    }),
  );

  app.delete("/:teamId/members/:userId", (context) =>
    withTeamUser(context, async (userId) => {
      await teams(context).removeMember(userId, teamIdOf(context), context.req.param("userId"));
      return new Response(null, { status: 204 });
    }),
  );

  return app;
}

/** `/team-invites/:token`: the accept page of an invite link. */
export function createTeamInviteRoutes(teams: TeamServiceFactory = defaultTeams): ApiApp {
  const app = createApiRouter();
  app.get("/:token", (context) =>
    withTeamUser(context, async (userId) =>
      json(await teams(context).previewInvite(userId, context.req.param("token"))),
    ),
  );
  app.post("/:token/accept", (context) =>
    withTeamUser(context, async (userId) =>
      json(await teams(context).acceptInvite(userId, context.req.param("token"))),
    ),
  );
  return app;
}

/** Mounted under `/projects/:projectId/team`: moves a personal project into a team. */
export function createProjectTeamRoutes(teams: TeamServiceFactory = defaultTeams): ApiApp {
  const app = createApiRouter();
  app.put("/", (context) =>
    withTeamUser(context, async (userId) => {
      const input = await parseValidatedJson(context, moveProjectToTeamInputSchema, "Invalid team.");
      if (!input.ok) return input.response;
      await teams(context).moveProject(userId, context.req.param("projectId") ?? "", input.data.teamId);
      return json({ teamId: input.data.teamId });
    }),
  );
  return app;
}

function teamIdOf(context: ApiContext): string {
  return context.req.param("teamId") ?? "";
}

/** Invite links point at the dashboard origin. */
function webOriginOf(context: ApiContext): string {
  return getWebOrigin(context.req.raw, context.env);
}

function withTeamUser(context: ApiContext, handler: (userId: string) => Promise<Response>): Promise<Response> {
  return withUser(context, async (userId) => {
    try {
      return await handler(userId);
    } catch (cause) {
      const response = teamErrorResponse(cause);
      if (response) return response;
      throw cause;
    }
  });
}

const INVITE_STATUS: Record<TeamInviteFailure, number> = {
  invite_not_found: 404,
  invite_used: 410,
  invite_expired: 410,
  invite_revoked: 410,
  invite_email_mismatch: 403,
  already_member: 409,
};

function teamErrorResponse(cause: unknown): Response | null {
  if (cause instanceof TeamNotFoundError) return notFound();
  if (cause instanceof TeamAccessError) return error(cause.message, 403, { code: "forbidden" });
  if (cause instanceof TeamConflictError) return error(cause.message, cause.status, { code: cause.code });
  if (cause instanceof TeamInviteError) return error(cause.message, INVITE_STATUS[cause.code], { code: cause.code });
  return null;
}
