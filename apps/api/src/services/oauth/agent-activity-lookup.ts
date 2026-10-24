/**
 * The last time an agent acted under a grant. Backed by `agent_activity`
 * once that table exists (spec 11.2); until then no grant has activity.
 */
export interface AgentActivityLookup {
  lastActivityByGrantRef(
    userId: string,
    grantRefs: readonly string[],
  ): Promise<ReadonlyMap<string, Date>>;
}

export const noAgentActivity: AgentActivityLookup = {
  lastActivityByGrantRef: async () => new Map(),
};
