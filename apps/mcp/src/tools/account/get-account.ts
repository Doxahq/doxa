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

const limitOutput = z.union([z.number().int().nonnegative(), z.literal("unlimited")]);

/** Billing spec 15.3: plan, credits, pay-as-you-go and today's tool calls. No tool buys or changes a plan. */
const billingAccountOutput = z
  .object({
    accountId: z.string(),
    ownerKind: z.enum(["user", "team"]),
    teamId: z.string().nullable(),
    plan: z.string(),
    credits: z.object({ available: z.number().int().nonnegative(), resetsAt: z.string() }).strict(),
    payg: z
      .object({ active: z.boolean(), debt: z.number().int().nonnegative(), monthlyLimitCents: z.number().int().nonnegative() })
      .strict(),
    toolCalls: z.object({ today: z.number().int().nonnegative(), limit: limitOutput, resetsAt: z.string() }).strict(),
  })
  .strict();

export const getAccountTool = defineMcpTool({
  name: "get_account",
  title: "Get account",
  description:
    "Returns who this connection acts for and what it may do: the user ID, the client, the granted permissions, the projects it may use, and the user's teams with their role in each. A role limits what a tool can do on that team's projects. When billing enforcement is on (or in shadow), it also returns each billing account the user can read: the plan, available AI credits and when they reset, the pay-as-you-go debt and monthly limit, and today's tool-call count against the daily limit.",
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
      /** Absent while billing enforcement is off. */
      billing: z.array(billingAccountOutput).optional(),
    })
    .strict(),
  async run({ actor, services }) {
    const { channel } = actor;
    const teams = await services.teams.listForUser(actor.principal.userId);
    const billing = (await services.billing?.accountsFor(actor.principal.userId, teams)) ?? null;
    return {
      userId: actor.principal.userId,
      client: { id: channel.clientId, name: channel.clientName },
      scopes: [...channel.scopes].sort(),
      projectScope: toProjectScopeOutput(channel.projectScope),
      teams: teams.map(({ id, name, role }) => ({ id, name, role })),
      ...(billing
        ? { billing: billing.map((account) => ({ ...account, credits: { ...account.credits }, payg: { ...account.payg }, toolCalls: { ...account.toolCalls } })) }
        : {}),
    };
  },
});

function toProjectScopeOutput(
  scope: ProjectScope,
): z.infer<typeof projectScopeOutput> {
  if (scope.kind === "all") return { kind: "all" };
  return { kind: "selected", projectIds: [...scope.projectIds] };
}
