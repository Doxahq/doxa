import { FREE_PLAN_SEARCH_POLICY, PAID_PLAN_SEARCH_POLICY } from "@doxahq/contracts/entitlements";
import { SEARCH_PROVIDER_REQUEST_TIMEOUT_MS } from "@doxahq/docs-search/providers";
import { describe, expect, it, vi } from "vitest";

import {
  DocsSearchIndexWorker,
  type ClaimedDocsSearchTask,
  type DocsSearchRecheck,
} from "../../../src/services/docs-search/index-worker";
import { abortable } from "../../../src/services/docs-search/abortable";
import {
  DOCS_SEARCH_COLLECT_GRACE_SECONDS,
  DOCS_SEARCH_LEASE_SECONDS,
  DOCS_SEARCH_RUN_BUDGET_MS,
  DOCS_SEARCH_TASK_BUDGET_MS,
} from "../../../src/services/docs-search/limits";

const INDEX_KEY =
  "s_11111111111141118111111111111111_22222222222242228222222222222222_abcdef01abcdef01abcdef01abcdef01";
const task: ClaimedDocsSearchTask = {
  id: "t",
  siteId: "11111111-1111-4111-8111-111111111111",
  versionId: "22222222-2222-4222-8222-222222222222",
  projectId: "p",
  artifactPrefix: "sites/s/versions/v",
  attempts: 1,
  claimToken: "c",
};
const searchFile = JSON.stringify({
  schemaVersion: 1,
  contentVersion: "v",
  documents: [
    {
      id: "/a",
      slug: "/a",
      title: "A",
      description: "",
      breadcrumb: [],
      section: "default",
      headings: [],
      keywords: [],
      content: "a",
      lines: [],
    },
  ],
});

function setup(options: {
  paid?: boolean;
  choice?: string;
  isPublic?: boolean;
  provisioned?: boolean;
  searchFile?: string | null;
  writeError?: Error;
  allowWrite?: boolean;
  tasks?: ClaimedDocsSearchTask[];
  rechecks?: DocsSearchRecheck[];
  hasIndex?: () => Promise<boolean>;
  read?: (key: string) => Promise<string | null>;
}) {
  const queue = options.tasks ?? [task];
  const complete = vi.fn(async () => {});
  const fail = vi.fn(async () => {});
  const beginWrite = vi.fn(async () =>
    (options.allowWrite ?? true) ? INDEX_KEY : null,
  );
  const reopen = vi.fn(async (_id: string) => {});
  const markRechecked = vi.fn(async (_id: string) => {});
  const writeIndex = vi.fn(async (_input: { signal?: AbortSignal }) => {
    if (options.writeError) throw options.writeError;
    return { documents: 1, indexedBytes: 1 };
  });
  const hasIndex = vi.fn(options.hasIndex ?? (async () => true));
  const read = vi.fn(options.read ?? (async (key: string) => {
    if (key.endsWith("settings/site.json")) {
      return JSON.stringify({
        features: options.choice ? { searchProvider: options.choice } : {},
      });
    }
    return options.searchFile === undefined ? searchFile : options.searchFile;
  }));
  const worker = new DocsSearchIndexWorker({
    tasks: {
      claimNext: async () => queue.shift() ?? null,
      beginWrite,
      complete,
      fail,
      listRechecks: async () => options.rechecks ?? [],
      markRechecked,
      reopen,
    },
    policy: {
      getSearchPolicy: async () =>
        options.paid ? PAID_PLAN_SEARCH_POLICY : FREE_PLAN_SEARCH_POLICY,
    },
    writers:
      options.provisioned === false
        ? {}
        : { typesense: { writeIndex, removeIndex: vi.fn(), hasIndex } },
    read,
    isPublic: options.isPublic ?? true,
  });
  return { worker, complete, fail, writeIndex, beginWrite, reopen, markRechecked, hasIndex };
}

describe("search index worker", () => {
  it("gives a free site browser search and sends nothing to a provider", async () => {
    const { worker, complete, writeIndex, beginWrite } = setup({});
    await worker.run();
    expect(writeIndex).not.toHaveBeenCalled();
    expect(beginWrite).not.toHaveBeenCalled();
    expect(complete).toHaveBeenCalledWith(task, { provider: "minisearch", facts: null });
  });

  // SECURITY REGRESSION GUARDRAIL: a stored setting cannot exceed the plan.
  it("ignores a Typesense setting on a free site", async () => {
    const { worker, writeIndex, complete } = setup({ choice: "typesense" });
    await worker.run();
    expect(writeIndex).not.toHaveBeenCalled();
    expect(complete).toHaveBeenCalledWith(task, { provider: "minisearch", facts: null });
  });

  it("gives a paid site Typesense by default", async () => {
    const { worker, writeIndex, complete } = setup({ paid: true });
    await worker.run();
    expect(writeIndex).toHaveBeenCalledWith(
      expect.objectContaining({ indexKey: INDEX_KEY }),
    );
    expect(complete).toHaveBeenCalledWith(task, {
      provider: "typesense",
      facts: { documents: 1, indexedBytes: 1 },
    });
  });

  it("lets a paid site choose browser search", async () => {
    const { worker, writeIndex, complete } = setup({ paid: true, choice: "minisearch" });
    await worker.run();
    expect(writeIndex).not.toHaveBeenCalled();
    expect(complete).toHaveBeenCalledWith(task, { provider: "minisearch", facts: null });
  });

  // SECURITY REGRESSION GUARDRAIL: gated docs never go to a third party.
  it("sends nothing when production sits behind an access gate", async () => {
    const { worker, writeIndex } = setup({ paid: true, isPublic: false });
    await worker.run();
    expect(writeIndex).not.toHaveBeenCalled();
  });

  it("uses browser search when the provider has no credentials", async () => {
    const { worker, complete } = setup({ paid: true, provisioned: false });
    await worker.run();
    expect(complete).toHaveBeenCalledWith(task, { provider: "minisearch", facts: null });
  });

  it("records a failure for retry, with the error class only", async () => {
    const error = new Error("secret detail");
    const { worker, fail, complete } = setup({ paid: true, writeError: error });
    await worker.run();
    expect(complete).not.toHaveBeenCalled();
    expect(fail).toHaveBeenCalledWith(task, "Error");
  });

  it("fails when the search file is unreadable", async () => {
    const { worker, fail } = setup({ paid: true, searchFile: null });
    await worker.run();
    expect(fail).toHaveBeenCalledOnce();
  });

  it("records the provider before it writes", async () => {
    const { worker, beginWrite, writeIndex } = setup({ paid: true });
    await worker.run();
    expect(beginWrite).toHaveBeenCalledWith(task, "typesense");
    expect(beginWrite.mock.invocationCallOrder[0]).toBeLessThan(
      writeIndex.mock.invocationCallOrder[0]!,
    );
  });

  // PRODUCT REGRESSION GUARDRAIL: a stalled read must not hold the scheduler.
  it("ends the run when a read stalls, and writes nothing after that", async () => {
    const controller = new AbortController();
    const { worker, writeIndex, fail } = setup({
      paid: true,
      read: () => new Promise<string | null>(() => {}),
    });
    const run = worker.run(undefined, controller.signal);
    await vi.waitFor(() => expect(fail).not.toHaveBeenCalled());
    controller.abort(new DOMException("Budget", "TimeoutError"));
    await expect(run).resolves.toEqual({ processed: 1 });
    expect(writeIndex).not.toHaveBeenCalled();
    expect(fail).toHaveBeenCalledWith(task, "TimeoutError");
  });

  // PRODUCT REGRESSION GUARDRAIL: a writer must not recreate a deleted index.
  it("does not write when the read ends after the budget", async () => {
    const controller = new AbortController();
    let finishRead: (text: string) => void = () => {};
    const { worker, writeIndex, beginWrite } = setup({
      paid: true,
      read: (key) =>
        key.endsWith("settings/site.json")
          ? Promise.resolve("{}")
          : new Promise<string>((resolve) => {
              finishRead = resolve;
            }),
    });
    const run = worker.run(undefined, controller.signal);
    await vi.waitFor(() => expect(beginWrite).toHaveBeenCalled());
    controller.abort();
    await run;
    finishRead(searchFile);
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(writeIndex).not.toHaveBeenCalled();
  });

  // PRODUCT REGRESSION GUARDRAIL: a writer must not recreate a deleted index.
  it("does not write when the task lost its claim or its version", async () => {
    const { worker, writeIndex, complete, fail } = setup({ paid: true, allowWrite: false });
    await worker.run();
    expect(writeIndex).not.toHaveBeenCalled();
    expect(complete).not.toHaveBeenCalled();
    expect(fail).not.toHaveBeenCalled();
  });

  it("gives every write the run's deadline", async () => {
    const { worker, writeIndex } = setup({ paid: true });
    const signal = new AbortController().signal;
    await worker.run(undefined, signal);
    expect(writeIndex.mock.calls[0]?.[0]).toMatchObject({ indexKey: INDEX_KEY, signal });
  });

  it("stops claiming when the budget ends", async () => {
    const controller = new AbortController();
    const second = { ...task, id: "second" };
    const { worker, complete } = setup({ tasks: [task, second] });
    complete.mockImplementationOnce(async () => controller.abort());
    await expect(worker.run(undefined, controller.signal)).resolves.toEqual({
      processed: 1,
    });
  });

  it("claims one task at a time, so a lease starts when its work starts", async () => {
    const second = { ...task, id: "second" };
    const { worker, complete } = setup({ tasks: [task, second] });
    await worker.run();
    expect(complete).toHaveBeenCalledTimes(2);
  });
});

const recheck: DocsSearchRecheck = {
  id: "t",
  siteId: task.siteId,
  versionId: task.versionId,
  projectId: "p",
  artifactPrefix: task.artifactPrefix,
  status: "ready",
  provider: "typesense",
  indexKey: INDEX_KEY,
  siteProvider: "typesense",
  siteIndexKey: INDEX_KEY,
};
const browserRecheck = {
  ...recheck,
  status: "skipped",
  provider: "minisearch",
  indexKey: null,
  siteProvider: "minisearch",
  siteIndexKey: null,
};
const signal = () => new AbortController().signal;

describe("search provider recheck", () => {
  it("leaves a matching version alone", async () => {
    const { worker, reopen, markRechecked } = setup({
      paid: true,
      rechecks: [recheck],
    });
    await worker.reconcile(signal());
    expect(reopen).not.toHaveBeenCalled();
    expect(markRechecked).toHaveBeenCalledWith("t");
  });

  it("leaves a matching browser-search site alone", async () => {
    const { worker, reopen } = setup({ rechecks: [browserRecheck] });
    await worker.reconcile(signal());
    expect(reopen).not.toHaveBeenCalled();
  });

  it("indexes a paid site once credentials exist", async () => {
    const { worker, reopen } = setup({ paid: true, rechecks: [browserRecheck] });
    await worker.reconcile(signal());
    expect(reopen).toHaveBeenCalledWith("t");
  });

  it("moves a site off Typesense when it loses the plan", async () => {
    const { worker, reopen } = setup({ paid: false, rechecks: [recheck] });
    await worker.reconcile(signal());
    expect(reopen).toHaveBeenCalledWith("t");
  });

  it("repairs a site that serves another provider or another index", async () => {
    for (const changed of [
      { siteProvider: "minisearch" },
      { siteIndexKey: "s_other" },
      { siteIndexKey: null },
    ]) {
      const { worker, reopen } = setup({
        paid: true,
        rechecks: [{ ...recheck, ...changed }],
      });
      await worker.reconcile(signal());
      expect(reopen).toHaveBeenCalledWith("t");
    }
  });

  it("repairs a browser-search site that still names an index", async () => {
    const { worker, reopen } = setup({
      rechecks: [{ ...browserRecheck, siteIndexKey: INDEX_KEY }],
    });
    await worker.reconcile(signal());
    expect(reopen).toHaveBeenCalledWith("t");
  });

  it("rebuilds a ready index that is gone", async () => {
    const { worker, reopen } = setup({
      paid: true,
      rechecks: [recheck],
      hasIndex: async () => false,
    });
    await worker.reconcile(signal());
    expect(reopen).toHaveBeenCalledWith("t");
  });

  // PRODUCT REGRESSION GUARDRAIL: an outage must not look like a lost index, and
  // a row that cannot be checked must not hold the rows behind it.
  it("moves past a provider outage without treating it as a lost index", async () => {
    const second = { ...recheck, id: "second" };
    const { worker, reopen, markRechecked } = setup({
      paid: true,
      rechecks: [recheck, second],
      hasIndex: async () => {
        throw new Error("outage");
      },
    });
    await worker.reconcile(signal());
    expect(reopen).not.toHaveBeenCalled();
    expect(markRechecked.mock.calls.map(([id]) => id)).toEqual(["t", "second"]);
  });

  it("tries a failed version again", async () => {
    const { worker, reopen } = setup({
      paid: true,
      rechecks: [{ ...recheck, status: "failed" }],
    });
    await worker.reconcile(signal());
    expect(reopen).toHaveBeenCalledWith("t");
  });

  it("stops when the budget ends", async () => {
    const controller = new AbortController();
    controller.abort();
    const { worker, reopen, markRechecked } = setup({ rechecks: [recheck] });
    await worker.reconcile(controller.signal);
    expect(reopen).not.toHaveBeenCalled();
    expect(markRechecked).not.toHaveBeenCalled();
  });

  it("does not wait for a check that stalls", async () => {
    const controller = new AbortController();
    let readStarted = false;
    const { worker, markRechecked } = setup({
      paid: true,
      rechecks: [recheck],
      read: () => {
        readStarted = true;
        return new Promise<string | null>(() => {});
      },
    });
    const running = worker.reconcile(controller.signal);
    await vi.waitFor(() => expect(readStarted).toBe(true));
    controller.abort();
    await running;
    expect(markRechecked).toHaveBeenCalledWith("t");
  });
});

describe("abortable", () => {
  it("ends the wait at the abort, even if the work never settles", async () => {
    const controller = new AbortController();
    const waiting = abortable(new Promise(() => {}), controller.signal);
    controller.abort(new Error("budget"));
    await expect(waiting).rejects.toThrow("budget");
  });

  it("passes a result and an error through", async () => {
    const { signal: live } = new AbortController();
    await expect(abortable(Promise.resolve(1), live)).resolves.toBe(1);
    await expect(abortable(Promise.reject(new Error("no")), live)).rejects.toThrow("no");
  });

  it("does not leave an unhandled rejection after an abort", async () => {
    const controller = new AbortController();
    controller.abort(new Error("budget"));
    await expect(
      abortable(Promise.reject(new Error("late")), controller.signal),
    ).rejects.toThrow("budget");
  });
});

describe("search time rules", () => {
  it("keep writers and deletes apart", () => {
    const budgetSeconds = DOCS_SEARCH_RUN_BUDGET_MS / 1000;
    const requestSeconds = SEARCH_PROVIDER_REQUEST_TIMEOUT_MS / 1000;
    // Rechecks always get a share of the run.
    expect(DOCS_SEARCH_TASK_BUDGET_MS).toBeLessThan(DOCS_SEARCH_RUN_BUDGET_MS);
    // A lease outlives the run that holds it.
    expect(DOCS_SEARCH_LEASE_SECONDS).toBeGreaterThan(budgetSeconds + requestSeconds);
    // An index goes after every writer that might use it has stopped.
    expect(DOCS_SEARCH_COLLECT_GRACE_SECONDS).toBeGreaterThan(
      budgetSeconds + requestSeconds,
    );
  });
});
