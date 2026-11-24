import type { ProjectTeam } from "@doxahq/contracts/teams";
import type { Env } from "../env";
import { planSeamsFromEnv } from "./billing/plan-seams";

/**
 * Refuses a new project when the billing account already holds as many
 * projects as its plan allows (`account.projects`). It throws
 * `PlanLimitError` (HTTP 403 `plan_limit`). With `BILLING_ENFORCEMENT=off`
 * it does nothing. Two creations at the same moment can both pass: a soft
 * limit, like the team seat limit.
 */
export async function assertProjectLimit(
  env: Env,
  owner: { userId: string; team: ProjectTeam | null },
): Promise<void> {
  await planSeamsFromEnv(env).projectLimit.assertProjectAvailable({
    userId: owner.userId,
    teamId: owner.team?.id ?? null,
  });
}
