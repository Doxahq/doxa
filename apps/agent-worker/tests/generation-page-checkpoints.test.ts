import {
  emptyPageDependencyState,
  type StagedRuntimePage,
} from "@doxahq/contracts";
import { describe, expect, test } from "vitest";
import {
  createR2GenerationPageCheckpointStore,
  parseGenerationPageCheckpoint,
  runResumablePageBatch,
  type GenerationPageCheckpointStore,
  type WrittenPageBatch,
} from "../src/generation-page-checkpoints";

const pageIds = [
  "authentication",
  "overview",
  "installation",
  "configuration",
  "self-hosting",
  "quickstart",
] as const;

function page(id: string): StagedRuntimePage {
  return {
    id,
    title: id,
    route: `/${id}`,
    navigationPath: `default/${id}.md`,
    content: `# ${id}\n`,
    dependencies: emptyPageDependencyState(),
    contentHash: "a".repeat(64),
    pageInputHash: "b".repeat(64),
  };
}

class MemoryPageCheckpointStore implements GenerationPageCheckpointStore {
  private readonly pages = new Map<string, StagedRuntimePage>();

  key(pageId: string): string {
    return `_generation-checkpoints/job/production-pages/${encodeURIComponent(pageId)}.json`;
  }

  async read(pageId: string): Promise<StagedRuntimePage | null> {
    return this.pages.get(pageId) ?? null;
  }

  async write(value: StagedRuntimePage): Promise<string> {
    this.pages.set(value.id, value);
    return this.key(value.id);
  }
}

describe("resumable generation page batches", () => {
  test("a Workflow step replay invokes the model only for unfinished pages", async () => {
    const store = new MemoryPageCheckpointStore();
    const modelCalls = new Map<string, number>();
    let invocation = 0;
    const generate = async (
      pendingPageIds: readonly string[],
      checkpoint: (value: StagedRuntimePage) => Promise<void>,
    ): Promise<WrittenPageBatch> => {
      invocation++;
      const generated: StagedRuntimePage[] = [];
      for (const pageId of pendingPageIds) {
        modelCalls.set(pageId, (modelCalls.get(pageId) ?? 0) + 1);
        if (invocation === 1 && pageId === "quickstart") {
          throw new Error("stage transport failed");
        }
        const generatedPage = page(pageId);
        generated.push(generatedPage);
        await checkpoint(generatedPage);
      }
      return { pages: generated, failedPages: [] };
    };

    const replayOnce = async <T>(operation: () => Promise<T>): Promise<T> => {
      try {
        return await operation();
      } catch {
        return operation();
      }
    };

    await expect(replayOnce(() => runResumablePageBatch({
      pageIds,
      store,
      generate,
    }))).resolves.toEqual({
      keys: pageIds.map((pageId) => store.key(pageId)),
      failedPages: [],
    });

    expect(invocation).toBe(2);
    expect(Object.fromEntries(modelCalls)).toEqual({
      authentication: 1,
      overview: 1,
      installation: 1,
      configuration: 1,
      "self-hosting": 1,
      quickstart: 2,
    });
  });

  test("a page the stage gave up on is a failed page, not a batch error", async () => {
    const store = new MemoryPageCheckpointStore();

    const result = await runResumablePageBatch({
      pageIds: ["overview", "quickstart", "installation"],
      store,
      generate: async () => ({
        pages: [page("overview")],
        failedPages: [{ id: "quickstart", title: "Quickstart", reason: "Overloaded" }],
      }),
    });

    expect(result).toEqual({
      keys: [store.key("overview")],
      failedPages: [
        { id: "quickstart", title: "Quickstart", reason: "Overloaded" },
        {
          id: "installation",
          title: "installation",
          reason: "The write stage returned no page and no failure for it.",
        },
      ],
    });
  });

  test("rejects a checkpoint for a page outside the requested batch", async () => {
    const store = new MemoryPageCheckpointStore();

    await expect(runResumablePageBatch({
      pageIds: ["overview"],
      store,
      generate: async (_pendingPageIds, checkpoint) => {
        await checkpoint(page("installation"));
        return { pages: [], failedPages: [] };
      },
    })).rejects.toThrow(
      "Write stage checkpointed an unexpected page: installation",
    );
  });
});

describe("generation page checkpoint parsing", () => {
  test("accepts page-granular and legacy batch checkpoint shapes", () => {
    const overview = page("overview");

    expect(parseGenerationPageCheckpoint(overview)).toEqual([overview]);
    expect(parseGenerationPageCheckpoint([overview])).toEqual([overview]);
  });

  test("uses a stable per-page key so replay overwrites instead of duplicating output", async () => {
    const objects = new Map<string, string>();
    const bucket = {
      async get(key: string) {
        const value = objects.get(key);
        if (value === undefined) return null;
        return {
          text: async () => value,
        } as R2ObjectBody;
      },
      async put(key: string, value: string) {
        objects.set(key, value);
        return null;
      },
    };
    const store = createR2GenerationPageCheckpointStore(
      bucket,
      "_generation-checkpoints/job/production-pages",
    );
    const initial = page("guides/quickstart");
    const repaired = {
      ...initial,
      content: "# Repaired quickstart\n",
      contentHash: "c".repeat(64),
    };

    const firstKey = await store.write(initial);
    const replayedKey = await store.write(repaired);

    expect(firstKey).toBe(
      "_generation-checkpoints/job/production-pages/guides%2Fquickstart.json",
    );
    expect(replayedKey).toBe(firstKey);
    expect(objects.size).toBe(1);
    await expect(store.read("guides/quickstart")).resolves.toEqual(repaired);
  });
});
