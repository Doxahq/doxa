import { schema } from "@doxahq/db";
import {
  DOCS_DELETED_SITE_TARGET,
  DOCS_PRERENDER_RENDER_TARGET,
} from "@doxahq/contracts/storage-gc";
import { describe, expect, test, vi } from "vitest";

const mock = vi.hoisted(() => ({ createDb: vi.fn() }));
vi.mock("@doxahq/db", async (original) => ({
  ...(await original<typeof import("@doxahq/db")>()),
  createDb: mock.createDb,
}));
import {
  ProjectDeletionError,
  ProjectDeletionRepository,
} from "../../src/repositories/project-deletion";

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
  onConflictDoUpdate() {
    return this;
  }
  returning() {
    return this;
  }
}

const siteId = "11111111-1111-4111-8111-111111111111";
const owner = { userId: "user-1", projectId: "project-1" };
const render = { siteId, renderId: "a".repeat(64), hostname: "acme.doxa.page" };

/** Answers each select in order: project, active job, site, domains. */
function database(selects: Row[][], renders: Row[] = []) {
  const inserts: Array<{ table: unknown; values: Row }> = [];
  const deletes: unknown[] = [];
  let nextId = 0;
  const queries = {
    select: () => new Result(selects.shift() ?? []),
    selectDistinct: () => new Result(renders),
    insert: (table: unknown) => ({
      values: (values: Row) => {
        inserts.push({ table, values });
        nextId += 1;
        return new Result([{ id: `entry-${nextId}` }]);
      },
    }),
    delete: (table: unknown) => {
      deletes.push(table);
      return new Result([]);
    },
  };
  mock.createDb.mockReturnValue({
    ...queries,
    transaction: async <T>(callback: (tx: typeof queries) => Promise<T>) =>
      callback(queries),
  });
  return { inserts, deletes };
}

const repository = () =>
  new ProjectDeletionRepository({ DOCS_BASE_DOMAIN: "doxa.page" } as never);

describe("ProjectDeletionRepository.deleteForUser", () => {
  test("deletes the project and queues the cache purge and every storage resource", async () => {
    const { inserts, deletes } = database(
      [
        [{ id: "project-1" }],
        [],
        [{ id: siteId, slug: "acme" }],
        [{ hostname: "docs.acme.com" }],
      ],
      [render],
    );

    const deleted = await repository().deleteForUser(owner);

    expect(deletes).toEqual([schema.projects]);
    expect(deleted).toEqual({
      projectId: "project-1",
      siteId,
      storageEntryIds: ["entry-4", "entry-5"],
    });
    const invalidations = inserts
      .filter(({ table }) => table === schema.docsCacheInvalidations)
      .map(({ values }) => values.hostname ?? null);
    expect(invalidations).toEqual([null, "docs.acme.com", "acme.doxa.page"]);
    const entries = inserts
      .filter(({ table }) => table === schema.storageGcEntries)
      .map(({ values }) => ({ target: values.target, resource: values.resource }));
    expect(entries).toEqual([
      { target: DOCS_PRERENDER_RENDER_TARGET, resource: render },
      { target: DOCS_DELETED_SITE_TARGET, resource: { siteId } },
    ]);
  });

  test("refuses while a generation is queued or running", async () => {
    const { inserts, deletes } = database([
      [{ id: "project-1" }],
      [{ id: "job-1" }],
    ]);

    await expect(repository().deleteForUser(owner)).rejects.toMatchObject({
      code: "generation_active",
    });
    expect(deletes).toEqual([]);
    expect(inserts).toEqual([]);
  });

  test("reports a project that the user does not own as not found", async () => {
    const { deletes } = database([[]]);

    const result = repository().deleteForUser(owner);

    await expect(result).rejects.toBeInstanceOf(ProjectDeletionError);
    await expect(result).rejects.toMatchObject({ code: "project_not_found" });
    expect(deletes).toEqual([]);
  });
});
