export interface DocsDomainLimitContext {
  userId: string;
  projectId: string;
}

export interface DocsDomainLimitPolicy {
  getLimit(context: DocsDomainLimitContext): Promise<number>;
}

export const DEFAULT_CUSTOM_DOMAIN_LIMIT = 1;

export function createDocsDomainLimitPolicy(): DocsDomainLimitPolicy {
  return {
    getLimit: async () => DEFAULT_CUSTOM_DOMAIN_LIMIT,
  };
}
