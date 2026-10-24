import { schema } from "@doxahq/db";
import { describe, expect, test, vi } from "vitest";

const mock = vi.hoisted(() => ({ createDb: vi.fn() }));
vi.mock("@doxahq/db", async (original) => ({
  ...(await original<typeof import("@doxahq/db")>()),
  createDb: mock.createDb,
}));
import {
  DocsDomainsRepository,
  type DocsDomainProvisioningState,
} from "../../src/repositories/docs-domains";

type Row = Record<string, unknown>;
class Result extends Promise<Row[]> {
  static get [Symbol.species]() {
    return Promise;
  }
  constructor(rows: Row[]) {
    super((resolve) => resolve(rows));
  }
  from() {
    return this;
  }
  where() {
    return this;
  }
  limit() {
    return this;
  }
  for() {
    return this;
  }
  innerJoin() {
    return this;
  }
  returning() {
    return this;
  }
}

const site = { siteId: "site-1", projectId: "project-1" };
const domain = {
  ...site,
  id: "domain-1",
  hostname: "docs.example.com",
  status: "active",
  verificationStatus: "verified",
  createdAt: new Date(),
  updatedAt: new Date(),
};
const owner = {
  userId: "user-1",
  projectId: "project-1",
  domainId: "domain-1",
};
const provisioning: DocsDomainProvisioningState = {
  provider: "cloudflare",
  providerHostnameId: "cf-host",
  providerStatus: "active",
  providerSslStatus: "active",
  verificationStatus: "verified",
  ownershipVerification: null,
  ownershipVerificationHttp: null,
  sslValidationRecords: [],
  verificationError: null,
};
const routing = {
  status: "healthy" as const,
  httpStatus: 204,
  error: null,
  checkedAt: new Date(),
};

function database(selects: Row[][], deleted: Row[] = [domain]) {
  const invalidations: Row[] = [];
  const queries = {
    select: () => new Result(selects.shift() ?? []),
    insert: (table: unknown) => ({
      values: (values: Row) => {
        if (table === schema.docsCacheInvalidations) invalidations.push(values);
        return new Result([{ ...domain, ...values }]);
      },
    }),
    update: () => ({
      set: (values: Row) => new Result([{ ...domain, ...values }]),
    }),
    delete: () => new Result(deleted),
  };
  const db = {
    ...queries,
    transaction: async <T>(
      callback: (tx: typeof queries) => Promise<T>,
    ): Promise<T> => callback(queries),
  };
  mock.createDb.mockReturnValue(db);
  return invalidations;
}

describe("custom domain invalidation", () => {
  test("invalidates the new site's and hostname's old mapping when adding a domain", async () => {
    const tasks = database([[site], [{ id: "project-1" }], [{ value: 0 }], []]);
    await new DocsDomainsRepository({} as never).createCustomDomain({
      ...owner,
      hostname: domain.hostname,
      customDomainLimit: 1,
    });
    expect(tasks).toEqual([
      { id: expect.any(String), siteId: "site-1", hostname: domain.hostname },
    ]);
  });

  test.each([
    { before: "disabled", after: "active" },
    { before: "active", after: "disabled" },
  ] as const)(
    "invalidates when routing eligibility changes from $before to $after",
    async ({ before, after }) => {
      const tasks = database([[site], [{ ...domain, status: before }]]);
      await new DocsDomainsRepository({} as never).applyProvisioning({
        ...owner,
        status: after,
        provisioning,
        routing,
      });
      expect(tasks).toEqual([
        { id: expect.any(String), siteId: "site-1", hostname: domain.hostname },
      ]);
    },
  );

  test("invalidates a hostname which loses verification", async () => {
    const tasks = database([[site], [domain]]);
    await new DocsDomainsRepository({} as never).applyProvisioning({
      ...owner,
      status: "active",
      provisioning: { ...provisioning, verificationStatus: "pending" },
      routing,
    });
    expect(tasks).toHaveLength(1);
  });

  test("does not purge on a status refresh which keeps routing eligibility", async () => {
    const tasks = database([[site], [domain]]);
    await new DocsDomainsRepository({} as never).applyProvisioning({
      ...owner,
      status: "active",
      provisioning,
      routing,
    });
    expect(tasks).toEqual([]);
  });

  test("invalidates the site and hostname when deleting a domain", async () => {
    const tasks = database([[site]]);
    expect(
      await new DocsDomainsRepository({} as never).deleteForProject(owner),
    ).toBe(true);
    expect(tasks).toEqual([
      { id: expect.any(String), siteId: "site-1", hostname: domain.hostname },
    ]);
  });

  test("does not purge for a missing domain", async () => {
    const tasks = database([[site]], []);
    expect(
      await new DocsDomainsRepository({} as never).deleteForProject(owner),
    ).toBe(false);
    expect(tasks).toEqual([]);
  });
});
