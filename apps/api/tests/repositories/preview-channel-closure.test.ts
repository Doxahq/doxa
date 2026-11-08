import { beforeEach, describe, expect, test, vi } from "vitest";
import type { DocsCacheInvalidation } from "@doxahq/contracts";
import type { Env } from "../../src/env";

interface ChannelRow {
  id: string;
  siteId: string;
  hostname: string;
  currentVersionId: string | null;
  lifecycleState: "active" | "closed" | "expired";
}

const mocks = vi.hoisted(() => ({
  channels: [] as ChannelRow[],
  updates: [] as Record<string, unknown>[],
  invalidations: [] as DocsCacheInvalidation[],
  retireReplacedPreview: vi.fn(async () => undefined),
}));

/** A transaction that answers the channel select and records each update. */
const tx = {
  select: () => ({
    from: () => ({
      where: () => ({ for: async () => mocks.channels }),
    }),
  }),
  update: () => ({
    set: (values: Record<string, unknown>) => ({
      where: async () => {
        mocks.updates.push(values);
      },
    }),
  }),
};

vi.mock("@doxahq/db", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@doxahq/db")>()),
  createDb: () => ({}),
}));

vi.mock("../../src/repositories/docs-cache-mutation", () => ({
  withDocsCacheInvalidation: async (
    _db: unknown,
    _env: unknown,
    mutate: (transaction: typeof tx, enqueue: (input: DocsCacheInvalidation) => Promise<void>) => Promise<unknown>,
  ) =>
    mutate(tx, async (input) => {
      mocks.invalidations.push(input);
    }),
}));

vi.mock("../../src/repositories/docs-version-retirement", () => ({
  retireReplacedPreview: mocks.retireReplacedPreview,
}));

import { PreviewChannelClosureRepository } from "../../src/repositories/preview-channel-closure";

// Every dependency that reads the environment is mocked.
const env = {} as Env;
const closedAt = new Date("2026-11-08T12:00:00.000Z");
const input = { projectId: "project-1", provider: "github" as const, changeExternalId: "987654", closedAt };

describe("closing the preview channel of an ended pull request", () => {
  beforeEach(() => {
    mocks.channels = [];
    mocks.updates = [];
    mocks.invalidations = [];
    mocks.retireReplacedPreview.mockClear();
  });

  test("takes the channel offline, retires its version and purges its hostname", async () => {
    mocks.channels = [
      { id: "channel-1", siteId: "site-1", hostname: "doxa-pr-ab12.doxa.page", currentVersionId: "version-1", lifecycleState: "active" },
    ];

    await expect(new PreviewChannelClosureRepository(env).closeForChange(input)).resolves.toBe(1);

    expect(mocks.updates).toEqual([{ lifecycleState: "closed", currentVersionId: null, updatedAt: closedAt }]);
    expect(mocks.retireReplacedPreview).toHaveBeenCalledWith(
      tx,
      { siteId: "site-1", versionId: "version-1" },
      closedAt,
      "preview_closed",
    );
    expect(mocks.invalidations).toEqual([{ siteId: "site-1", hostname: "doxa-pr-ab12.doxa.page" }]);
  });

  test("does nothing for a channel that is already closed and empty", async () => {
    mocks.channels = [
      { id: "channel-1", siteId: "site-1", hostname: "doxa-pr-ab12.doxa.page", currentVersionId: null, lifecycleState: "closed" },
    ];

    await expect(new PreviewChannelClosureRepository(env).closeForChange(input)).resolves.toBe(0);

    expect(mocks.updates).toEqual([]);
    expect(mocks.retireReplacedPreview).not.toHaveBeenCalled();
    expect(mocks.invalidations).toEqual([]);
  });

  test("closes a channel with no version without retiring anything", async () => {
    mocks.channels = [
      { id: "channel-1", siteId: "site-1", hostname: "doxa-pr-ab12.doxa.page", currentVersionId: null, lifecycleState: "active" },
    ];

    await expect(new PreviewChannelClosureRepository(env).closeForChange(input)).resolves.toBe(1);

    expect(mocks.retireReplacedPreview).not.toHaveBeenCalled();
    expect(mocks.invalidations).toHaveLength(1);
  });

  test("answers 0 when the pull request never had a preview", async () => {
    await expect(new PreviewChannelClosureRepository(env).closeForChange(input)).resolves.toBe(0);
    expect(mocks.updates).toEqual([]);
  });
});
