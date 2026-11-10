/**
 * The last time an agent acted under a grant. `AgentActivityRepository`
 * implements this. `noAgentActivity` is for tests that do not need it.
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
