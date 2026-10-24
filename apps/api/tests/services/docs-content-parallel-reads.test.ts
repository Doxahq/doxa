import { describe, expect, test, vi } from "vitest";
import type { Env } from "../../src/env";
import { EffectiveTree } from "../../src/services/docs-branches/effective-tree";
import {
  DocsContentError,
  DocsContentService,
  type DocsContentServiceDeps,
} from "../../src/services/docs-content/service";
import type { DocsContentStore } from "../../src/services/docs-content/store";
import { freePlanEntitlements } from "../../src/services/free-plan-entitlements";
import {
  BASE_PREFIX,
  PROJECT_ID,
  USER_ID,
  createBranchContentFixture,
} from "../support/branch-content-fixture";
import type { InMemoryDocsBranchStore } from "../support/in-memory-docs-branches";

const mocks = vi.hoisted(() => ({ dependencies: vi.fn() }));

vi.mock("../../src/services/docs-content/dependencies", () => ({
  createDocsContentDependencies: mocks.dependencies,
}));

const actor = { userId: USER_ID, origin: "editor" } as const;

/**
 * Records each call of an async step, and which other steps were still
 * running when it started. Every step waits one timer tick, so two steps
 * overlap only when the code started them together.
 */
function recorder() {
  const running = new Set<string>();
  const calls: Array<{ name: string; alongside: string[] }> = [];
  return {
    calls,
    names: () => calls.map((call) => call.name),
    async step<T>(name: string, run: () => Promise<T>): Promise<T> {
      calls.push({ name, alongside: [...running] });
      running.add(name);
      try {
        await new Promise((resolve) => setTimeout(resolve, 1));
        return await run();
      } finally {
        running.delete(name);
      }
    },
    overlapped(first: string, second: string): boolean {
      return calls.some(
        (call) =>
          (call.name === first && call.alongside.includes(second)) ||
          (call.name === second && call.alongside.includes(first)),
      );
    },
  };
}

function recordingStore(
  inner: DocsContentStore,
  log: ReturnType<typeof recorder>,
  failRead: (key: string) => boolean = () => false,
): DocsContentStore {
  const relative = (key: string) => key.replace(`${BASE_PREFIX}/`, "");
  return {
    ...inner,
    read: (key) =>
      log.step(relative(key), async () => {
        if (key.includes("..")) throw new Error(`Unsafe docs artifact key: ${key}`);
        if (failRead(key)) throw new Error(`bucket unavailable: ${key}`);
        return inner.read(key);
      }),
    readBytes: (key) => log.step(relative(key), () => inner.readBytes(key)),
  };
}

function recordingBranches(
  branches: InMemoryDocsBranchStore,
  log: ReturnType<typeof recorder>,
  options: { failListing?: boolean } = {},
) {
  const resolveForUser = branches.resolveForUser.bind(branches);
  const listChanges = branches.listChanges.bind(branches);
  vi.spyOn(branches, "resolveForUser").mockImplementation((input) =>
    log.step("db.resolve", () => resolveForUser(input)),
  );
  vi.spyOn(branches, "listChanges").mockImplementation((input) =>
    log.step("db.changes", async () => {
      if (options.failListing) throw new Error("database unavailable");
      return listChanges(input);
    }),
  );
  return branches;
}

function service(
  options: {
    failRead?: (key: string) => boolean;
    failListing?: boolean;
    objects?: Array<[string, string]>;
  } = {},
) {
  const fixture = createBranchContentFixture();
  for (const [key, value] of options.objects ?? []) {
    fixture.objects.set(key, value);
  }
  const log = recorder();
  const deps: DocsContentServiceDeps = {
    store: recordingStore(fixture.store, log, options.failRead),
    branches: recordingBranches(fixture.branches, log, options),
    entitlements: freePlanEntitlements,
    assets: { head: async () => null },
  };
  return { service: new DocsContentService(deps), log, fixture };
}

describe("docs content reads run in parallel", () => {
  test("the overview reads the manifest and the sections together, and the settings with the navigation", async () => {
    const { service: docs, log } = service();

    const overview = await docs.getOverview(actor, PROJECT_ID, "main");

    expect(overview.pages.map((page) => page.href)).toEqual([
      "/",
      "/install",
      "/legacy",
    ]);
    expect(log.overlapped("db.resolve", "db.changes")).toBe(true);
    expect(log.overlapped("manifest.json", "settings/sections.json")).toBe(true);
    // The site settings reads (for this v1 manifest, `settings/features.json`)
    // start while the navigation is still being read.
    const navigation = ["settings/sections.json", "settings/documents.json"];
    const configReads = log.calls.filter(
      (call) =>
        !call.name.startsWith("db.") &&
        call.name !== "manifest.json" &&
        !navigation.includes(call.name),
    );
    expect(configReads.length).toBeGreaterThan(0);
    expect(
      configReads.some((call) =>
        call.alongside.some((name) => navigation.includes(name)),
      ) ||
        log.calls.some(
          (call) =>
            navigation.includes(call.name) &&
            call.alongside.some((name) =>
              configReads.some((read) => read.name === name),
            ),
        ),
    ).toBe(true);
  });

  test("the overview reads only the manifest of main for the settings", async () => {
    const { service: docs, log } = service();

    await docs.getOverview(actor, PROJECT_ID, "main");

    // The effective tree is main here: one navigation read, no second one.
    expect(log.names().filter((name) => name === "settings/sections.json")).toHaveLength(1);
  });

  test("a page reads the manifest and its source together", async () => {
    const { service: docs, log } = service();

    const page = await docs.getPage(actor, PROJECT_ID, "/install", "main");

    expect(page.publishedContent).toContain("Run the setup script.");
    expect(log.overlapped("manifest.json", "source/install/index.mdx")).toBe(true);
    // A page needs no navigation.
    expect(log.names()).not.toContain("settings/sections.json");
  });

  test("a page that the manifest does not list is not found, even when its file exists", async () => {
    const { service: docs } = service({
      objects: [[`${BASE_PREFIX}/source/orphan/index.mdx`, "# Orphan\n"]],
    });

    await expect(
      docs.getPage(actor, PROJECT_ID, "/orphan", "main"),
    ).rejects.toMatchObject({ code: "not_found" });
  });

  test("an unsafe href is not found, not a storage error", async () => {
    const { service: docs } = service();

    await expect(
      docs.getPage(actor, PROJECT_ID, "/../escape", "main"),
    ).rejects.toMatchObject({ code: "not_found" });
  });

  test("a failed source read of a listed page is read again", async () => {
    let failures = 1;
    const { service: docs, log } = service({
      failRead: (key) => key.endsWith("source/install/index.mdx") && failures-- > 0,
    });

    const page = await docs.getPage(actor, PROJECT_ID, "/install", "main");

    expect(page.publishedContent).toContain("Run the setup script.");
    expect(log.names().filter((name) => name === "source/install/index.mdx")).toHaveLength(2);
  });

  test("a source read that keeps failing surfaces its error", async () => {
    const { service: docs } = service({
      failRead: (key) => key.endsWith("source/install/index.mdx"),
    });

    await expect(
      docs.getPage(actor, PROJECT_ID, "/install", "main"),
    ).rejects.toThrow(/bucket unavailable/);
  });

  test("the MDX report resolves the branch and lists its changes together", async () => {
    const { service: docs, log } = service();

    await docs.getMdxReport(actor, PROJECT_ID, "main");

    expect(log.overlapped("db.resolve", "db.changes")).toBe(true);
  });

  test("an unknown branch still answers branch_not_found when the listing fails too", async () => {
    const { service: docs } = service({ failListing: true });

    await expect(
      docs.getOverview(actor, PROJECT_ID, "not-a-branch"),
    ).rejects.toMatchObject({ code: "branch_not_found" });
    await expect(
      docs.getMdxReport(actor, PROJECT_ID, "not-a-branch"),
    ).rejects.toMatchObject({ code: "branch_not_found" });
  });

  test("the published view does not list changes", async () => {
    const { service: docs, log } = service();

    await docs.getOverview(actor, PROJECT_ID, "main", { published: true });

    expect(log.names()).not.toContain("db.changes");
  });
});

describe("the effective tree", () => {
  test("a manifest error wins over a navigation error", async () => {
    const tree = new EffectiveTree(
      {
        read: async (key) => {
          if (key.endsWith("manifest.json")) return "{not json";
          throw new Error("navigation unavailable");
        },
        listKeys: async () => [],
      },
      BASE_PREFIX,
      [],
    );

    await expect(tree.content()).rejects.toBeInstanceOf(DocsContentError);
  });

  test("manifest() reads only the manifest", async () => {
    const reads: string[] = [];
    const fixture = createBranchContentFixture();
    const tree = new EffectiveTree(
      {
        read: (key) => {
          reads.push(key);
          return fixture.store.read(key);
        },
        listKeys: fixture.store.listKeys,
      },
      BASE_PREFIX,
      [],
    );

    const manifest = await tree.manifest();

    expect(manifest.pages).toHaveLength(3);
    expect(reads).toEqual([`${BASE_PREFIX}/manifest.json`]);
  });
});

describe("one request reads the manifest once", () => {
  test("fromEnv shares one read of each key across the overview", async () => {
    const fixture = createBranchContentFixture();
    const reads: string[] = [];
    mocks.dependencies.mockReturnValue({
      store: {
        ...fixture.store,
        read: (key: string) => {
          reads.push(key);
          return fixture.store.read(key);
        },
      },
      branches: fixture.branches,
      entitlements: freePlanEntitlements,
      assets: { head: async () => null },
    } satisfies DocsContentServiceDeps);

    const docs = DocsContentService.fromEnv({} as Env);
    await docs.getOverview(actor, PROJECT_ID, "main");
    await docs.getPage(actor, PROJECT_ID, "/install", "main");

    expect(
      reads.filter((key) => key === `${BASE_PREFIX}/manifest.json`),
    ).toHaveLength(1);
  });

  test("fromEnv measures the steps when a timing is given", async () => {
    const fixture = createBranchContentFixture();
    mocks.dependencies.mockReturnValue({
      store: fixture.store,
      branches: fixture.branches,
      entitlements: freePlanEntitlements,
      assets: { head: async () => null },
    } satisfies DocsContentServiceDeps);
    const names: string[] = [];

    const docs = DocsContentService.fromEnv({} as Env, {
      measure: (name, step) => {
        names.push(name);
        return step();
      },
    });
    await docs.getOverview(actor, PROJECT_ID, "main");
    await docs.getPage(actor, PROJECT_ID, "/install", "main");

    expect(new Set(names)).toEqual(
      new Set([
        "db.resolve",
        "db.changes",
        "r2.manifest",
        "r2.nav",
        "r2.config",
        "r2.page",
      ]),
    );
  });
});
