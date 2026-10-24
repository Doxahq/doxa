import { oauthScopeSchema } from "@doxahq/contracts/agent-access";
import { teamRoleSchema } from "@doxahq/contracts/teams";
import { z } from "zod";
import type { ProjectScope } from "@doxahq/api/services/agent-access/actor";
import { defineMcpTool } from "../../tool-definition";
import { READ_ONLY_ANNOTATIONS } from "../shared";

const projectScopeOutput = z.discriminatedUnion("kind", [
  z.object({ kind: z.literal("all") }).strict(),
  z
    .object({ kind: z.literal("selected"), projectIds: z.array(z.string()) })
    .strict(),
]);

export const getAccountTool = defineMcpTool({
  name: "get_account",
  title: "Get account",
  description:
    "Returns who this connection acts for and what it may do: the user ID, the client, the granted permissions, the projects it may use, and the user's teams with their role in each. A role limits what a tool can do on that team's projects.",
  scope: null,
  cost: "read",
  annotations: READ_ONLY_ANNOTATIONS,
  input: z.object({}).strict(),
  output: z
    .object({
      userId: z.string(),
      client: z.object({ id: z.string(), name: z.string() }).strict(),
      scopes: z.array(oauthScopeSchema),
      projectScope: projectScopeOutput,
      teams: z.array(
        z.object({ id: z.string(), name: z.string(), role: teamRoleSchema }).strict(),
      ),
    })
    .strict(),
  async run({ actor, services }) {
    const { channel } = actor;
    const teams = await services.teams.listForUser(actor.principal.userId);
    return {
      userId: actor.principal.userId,
      client: { id: channel.clientId, name: channel.clientName },
      scopes: [...channel.scopes].sort(),
      projectScope: toProjectScopeOutput(channel.projectScope),
      teams: teams.map(({ id, name, role }) => ({ id, name, role })),
    };
  },
});

function toProjectScopeOutput(
  scope: ProjectScope,
): z.infer<typeof projectScopeOutput> {
  if (scope.kind === "all") return { kind: "all" };
  return { kind: "selected", projectIds: [...scope.projectIds] };
}
