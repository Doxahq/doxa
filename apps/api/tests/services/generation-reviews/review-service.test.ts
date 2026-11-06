import { describe, expect, test } from "vitest";
import {
  branchIdSchema,
  relativeNavigationPathForSection,
} from "@doxahq/contracts/docs-branches";
import { buildArtifactPrefix, sourcePathForHref } from "@doxahq/docs-engine";

import type { BranchChangeWrite } from "../../../src/repositories/docs-branches";
import type { StoredBranchChange } from "../../../src/repositories/docs-branch-records";
import type {
  GenerationReviewPageWrite,
  StoredGenerationReview,
  StoredGenerationReviewPage,
} from "../../../src/repositories/generation-review-records";
import type {
  DecideReviewResult,
  ReviewExpectation,
  StoredReviewDecision,
  ReviewRunSnapshot,
  ReviewSiteSnapshot,
  SaveRunReviewResult,
} from "../../../src/repositories/generation-reviews";
import type {
  FlaggedPage,
  PageNotice,
  OwnedPageFlag,
  PageLock,
} from "@doxahq/contracts/generation-reviews";
import { applyStructureEdit } from "../../../src/services/docs-content/structure";
import { structureArtifactFiles } from "../../../src/services/generation-reviews/review-changes";
import { GenerationReviewService } from "../../../src/services/generation-reviews/review-service";
import { loadReviewTree } from "../../../src/services/generation-reviews/review-tree";
import {
  createInMemoryDocsContentStore,
  type InMemoryObjects,
} from "../../support/in-memory-docs-content-store";

const SITE_ID = "20000000-0000-4000-8000-000000000001";
const PROJECT_ID = "20000000-0000-4000-8000-000000000002";
const OWNER_ID = "owner-1";
const MAIN_VERSION_ID = "20000000-0000-4000-8000-000000000003";
const FIRST_RUN_VERSION_ID = "20000000-0000-4000-8000-000000000004";
const SECOND_RUN_VERSION_ID = "20000000-0000-4000-8000-000000000005";
const BRANCH_ID = branchIdSchema.parse("20000000-0000-4000-8000-000000000006");
const MAIN_PREFIX = buildArtifactPrefix(SITE_ID, MAIN_VERSION_ID);

type Node = { heading: string } | { title: string; href: string };

interface SiteFiles {
  nodes: Node[];
  bodies: Record<string, string>;
}

function writeSite(
  objects: InMemoryObjects,
  versionId: string,
  site: SiteFiles,
): string {
  const prefix = buildArtifactPrefix(SITE_ID, versionId);
  const pages = site.nodes.flatMap((node) =>
    "href" in node
      ? [{ ...node, sourcePath: sourcePathForHref(node.href) }]
      : [],
  );
  objects.set(
    `${prefix}/manifest.json`,
    JSON.stringify({
      siteId: SITE_ID,
      versionId,
      projectSlug: "example",
      generatedAt: "2026-10-11T00:00:00.000Z",
      pages,
    }),
  );
  objects.set(
    `${prefix}/settings/sections.json`,
    JSON.stringify([{ slug: "default", label: "Docs", default: true }]),
  );
  objects.set(
    `${prefix}/${relativeNavigationPathForSection("default")}`,
    JSON.stringify(site.nodes),
  );
  for (const [href, body] of Object.entries(site.bodies)) {
    objects.set(`${prefix}/${sourcePathForHref(href)}`, body);
  }
  return prefix;
}

const PUBLISHED: SiteFiles = {
  nodes: [
    { title: "Intro", href: "/" },
    { title: "Install", href: "/install" },
    { title: "Pricing", href: "/pricing" },
  ],
  bodies: { "/": "intro", "/install": "install v1", "/pricing": "by hand" },
};

const GENERATED: SiteFiles = {
  nodes: [
    { title: "Intro", href: "/" },
    { title: "Install", href: "/install" },
    { title: "Webhooks", href: "/webhooks" },
  ],
  bodies: { "/": "intro", "/install": "install v2", "/webhooks": "webhooks" },
};

/** A seeded run: it rewrote Install, listed one conflict, and left Pricing out. */
const SEEDED: SiteFiles = {
  nodes: [
    { title: "Intro", href: "/" },
    { title: "Install", href: "/install" },
  ],
  bodies: {
    "/": "intro",
    "/install":
      "install v2\n\n{/* doxa-seed-conflicts\n- Install runs `make` -> the source uses `pnpm build` (Makefile)\n*/}\n",
  },
};

interface FakeJob {
  versionId: string;
  replacesEditorContent: boolean;
}

interface FakeOpenReview {
  review: StoredGenerationReview;
  pages: StoredGenerationReviewPage[];
  branch: {
    id: string;
    name: string;
    baseVersionId: string;
    revision: number;
    changes: Map<string, StoredBranchChange>;
  };
}

/** The review repository, in memory, with the same compare-and-set rules. */
class InMemoryReviews {
  readonly jobs = new Map<string, FakeJob>();
  readonly events: string[] = [];
  readonly closed: StoredGenerationReview[] = [];
  locks: PageLock[] = [];
  open: FakeOpenReview | null = null;

  async snapshotForProject(): Promise<ReviewSiteSnapshot> {
    return this.siteSnapshot();
  }

  async snapshotForJob(jobId: string): Promise<ReviewRunSnapshot | null> {
    const job = this.jobs.get(jobId);
    if (!job) return null;
    return {
      ...this.siteSnapshot(),
      jobId,
      generated: {
        versionId: job.versionId,
        artifactPrefix: buildArtifactPrefix(SITE_ID, job.versionId),
      },
      replacesEditorContent: job.replacesEditorContent,
    };
  }

  async existsForJob(jobId: string): Promise<boolean> {
    return (
      this.open?.review.jobId === jobId ||
      this.closed.some((review) => review.jobId === jobId)
    );
  }

  async recordUnchangedRun(jobId: string): Promise<void> {
    this.events.push(`unchanged:${jobId}`);
  }

  async saveRunReview(input: {
    jobId: string;
    generatedVersionId: string;
    createsBackup: boolean;
    ownedPageFlags: readonly OwnedPageFlag[];
    expected: ReviewExpectation;
    pages: readonly GenerationReviewPageWrite[];
    writes: readonly BranchChangeWrite[];
  }): Promise<SaveRunReviewResult> {
    const expectedOpen = input.expected.openReview;
    const current = this.open
      ? { id: this.open.review.id, branchRevision: this.open.branch.revision }
      : null;
    if (JSON.stringify(current) !== JSON.stringify(expectedOpen)) {
      return { status: "stale" };
    }

    const now = new Date("2026-10-11T00:00:00.000Z");
    const open: FakeOpenReview = this.open ?? {
      review: {
        id: "review-1",
        siteId: SITE_ID,
        branchId: BRANCH_ID,
        jobId: input.jobId,
        generatedVersionId: input.generatedVersionId,
        status: "open",
        createsBackup: input.createsBackup,
        backupBranchId: null,
        publishedVersionId: null,
        ownedPageFlags: [],
        closedByUserId: null,
        closedAt: null,
        createdAt: now,
        updatedAt: now,
      },
      pages: [],
      branch: {
        id: BRANCH_ID,
        name: "generation-review",
        baseVersionId: MAIN_VERSION_ID,
        revision: 0,
        changes: new Map(),
      },
    };
    open.review = {
      ...open.review,
      jobId: input.jobId,
      generatedVersionId: input.generatedVersionId,
      createsBackup: open.review.createsBackup || input.createsBackup,
      ownedPageFlags: input.ownedPageFlags,
    };
    open.pages = input.pages.map(({ decidedByUserId: _, ...page }) => page);
    this.apply(open, input.writes, "agent");
    open.branch.revision += 1;
    this.open = open;
    return { status: "saved", reviewId: open.review.id };
  }

  async decide(input: {
    expectedRevision: number;
    decisions: ReadonlyMap<string, StoredReviewDecision>;
    branchHrefs: ReadonlyMap<string, string | null>;
    writes: readonly BranchChangeWrite[];
  }): Promise<DecideReviewResult> {
    if (!this.open) return { status: "not_found" };
    if (this.open.branch.revision !== input.expectedRevision) {
      return { status: "stale" };
    }

    this.apply(this.open, input.writes, "agent");
    this.open.pages = this.open.pages.map((page) => {
      const stored = input.decisions.get(page.href);
      const branchHref = input.branchHrefs.has(page.href)
        ? (input.branchHrefs.get(page.href) ?? null)
        : page.branchHref;
      return stored
        ? {
            ...page,
            decision: stored.decision,
            branchHref,
            decidedAt: stored.byPerson ? new Date("2026-10-11T01:00:00.000Z") : null,
          }
        : page;
    });
    this.open.branch.revision += 1;
    return { status: "decided", revision: this.open.branch.revision };
  }

  async discard(): Promise<string[] | null> {
    if (!this.open) return null;
    this.closed.push({ ...this.open.review, status: "discarded" });
    this.open = null;
    return [];
  }

  /** A person's edit of a page body on the review branch. */
  editByPerson(href: string, content: string): void {
    if (!this.open) throw new Error("No open review");
    this.apply(
      this.open,
      [
        {
          path: sourcePathForHref(href),
          kind: "upsert",
          content,
          contentSha256: "person",
          byteSize: content.length,
        },
      ],
      "editor",
    );
    this.open.branch.revision += 1;
  }

  /**
   * A person's rename of a page on the review branch, as the editor saves
   * it: the body moves, the navigation follows, and the review page follows
   * the move.
   */
  async renameByPerson(
    store: Parameters<typeof loadReviewTree>[0],
    input: { href: string; slug: string; title: string },
  ): Promise<void> {
    if (!this.open) throw new Error("No open review");
    const branch = await loadReviewTree(store, MAIN_PREFIX, [
      ...this.open.branch.changes.values(),
    ]);
    const renamed = applyStructureEdit(branch.structure, {
      type: "rename_page",
      href: input.href,
      title: input.title,
      slug: input.slug,
    });
    const to = `/${input.slug}`;
    const body = (await branch.read(sourcePathForHref(input.href))) ?? "";
    const writes: BranchChangeWrite[] = [
      { path: sourcePathForHref(input.href), kind: "delete" },
      upsert(sourcePathForHref(to), body),
      ...structureArtifactFiles(renamed.structure, branch).map(([path, content]) =>
        content === null
          ? { path, kind: "delete" as const }
          : upsert(path, content),
      ),
    ];
    this.apply(this.open, writes, "editor");
    this.open.pages = this.open.pages.map((page) =>
      (page.branchHref ?? page.href) === input.href
        ? { ...page, branchHref: to }
        : page,
    );
    this.open.branch.revision += 1;
  }

  change(path: string): StoredBranchChange | undefined {
    return this.open?.branch.changes.get(path);
  }

  private apply(
    open: FakeOpenReview,
    writes: readonly BranchChangeWrite[],
    origin: StoredBranchChange["origin"],
  ): void {
    for (const write of writes) {
      if (write.kind === "reset") {
        open.branch.changes.delete(write.path);
        continue;
      }

      const common = {
        branchId: BRANCH_ID,
        path: write.path,
        updatedByUserId: OWNER_ID,
        origin,
        updatedAt: new Date(),
      };
      open.branch.changes.set(
        write.path,
        write.kind === "upsert"
          ? {
              ...common,
              kind: "upsert",
              content: write.content,
              contentSha256: write.contentSha256,
              byteSize: write.byteSize,
            }
          : {
              ...common,
              kind: "delete",
              content: null,
              contentSha256: null,
              byteSize: 0,
            },
      );
    }
  }

  private siteSnapshot(): ReviewSiteSnapshot {
    return {
      siteId: SITE_ID,
      siteSlug: "acme",
      projectId: PROJECT_ID,
      ownerUserId: OWNER_ID,
      main: { versionId: MAIN_VERSION_ID, artifactPrefix: MAIN_PREFIX },
      locks: this.locks,
      openReview: this.open
        ? {
            review: this.open.review,
            pages: this.open.pages,
            branch: {
              ...this.open.branch,
              changes: [...this.open.branch.changes.values()],
            },
          }
        : null,
    };
  }
}

function upsert(path: string, content: string): BranchChangeWrite {
  return {
    path,
    kind: "upsert",
    content,
    contentSha256: "person",
    byteSize: content.length,
  };
}

function setup(generated: SiteFiles = GENERATED) {
  const objects: InMemoryObjects = new Map();
  writeSite(objects, MAIN_VERSION_ID, PUBLISHED);
  writeSite(objects, FIRST_RUN_VERSION_ID, generated);
  writeSite(objects, SECOND_RUN_VERSION_ID, generated);
  const reviews = new InMemoryReviews();
  reviews.jobs.set("job-1", {
    versionId: FIRST_RUN_VERSION_ID,
    replacesEditorContent: true,
  });
  reviews.jobs.set("job-2", {
    versionId: SECOND_RUN_VERSION_ID,
    replacesEditorContent: false,
  });
  const published: unknown[] = [];
  const flagged = new Map<string, FlaggedPage[]>();
  const notices = new Map<string, PageNotice[]>();
  const store = createInMemoryDocsContentStore(objects);
  const service = new GenerationReviewService({
    reviews,
    store,
    publisher: {
      publishBranch: async (input) => {
        published.push(input);
        return {
          result: {
            versionId: "30000000-0000-4000-8000-000000000001",
            versionNumber: 2,
            publicationId: "publication-1",
            branchErased: true,
          },
          review: { backupBranchName: "backup-2026-10-11" },
        };
      },
    },
    collectStorage: async () => {},
    previewUrl: ({ projectSlug, docsVersionId }) =>
      `https://${projectSlug}--${docsVersionId.slice(0, 4)}.doxa.page`,
    flaggedPages: async (jobId) => flagged.get(jobId) ?? [],
    pageNotices: async (jobId) => notices.get(jobId) ?? [],
  });
  const scope = {
    projectId: PROJECT_ID,
    ownerUserId: OWNER_ID,
    actorUserId: "member-1",
  };
  return { reviews, service, published, scope, store, flagged, notices };
}

describe("GenerationReviewService", () => {
  test("lists the pages that the run could not write", async () => {
    const { service, scope, flagged } = setup();
    const page: FlaggedPage = {
      pageId: "documentation/webhooks",
      title: "Webhooks",
      reason: "Overloaded",
      outcome: "kept_published",
      href: "/webhooks",
    };
    flagged.set("job-1", [page]);

    await service.openForRun("job-1");

    expect((await service.get(scope))?.flaggedPages).toEqual([page]);
  });

  test("lists the pages that the run kept with open issues or behind the instructions", async () => {
    const { service, scope, notices } = setup();
    const kept: PageNotice = {
      pageId: "documentation/guide",
      title: "Guide",
      href: "/guide",
      kind: "open_issues",
      issues: [{ check: "instructionTerminology", message: 'Say "repository", not "repo".', instructions: true }],
    };
    const behind: PageNotice = {
      pageId: "documentation/locked",
      title: "Locked",
      href: "/locked",
      kind: "behind_instructions",
      issues: [],
    };
    notices.set("job-1", [kept, behind]);

    await service.openForRun("job-1");

    expect((await service.get(scope))?.pageNotices).toEqual([kept, behind]);
  });

  test("opens a review with page decisions and branch changes", async () => {
    const { reviews, service, scope } = setup();

    await expect(service.openForRun("job-1")).resolves.toBe("opened");
    const review = await service.get(scope);

    expect(review?.createsBackup).toBe(true);
    expect(review?.previewUrl).toBe(
      `https://acme--${FIRST_RUN_VERSION_ID.slice(0, 4)}.doxa.page`,
    );
    expect(
      review?.pages.map(({ href, change, decision }) => ({
        href,
        change,
        decision,
      })),
    ).toEqual([
      { href: "/install", change: "modified", decision: "accepted" },
      { href: "/webhooks", change: "added", decision: "accepted" },
      { href: "/pricing", change: "removed", decision: "accepted" },
    ]);
    expect(review?.pages.every((page) => page.decidedAt === null)).toBe(true);
    expect(reviews.change("source/install/index.mdx")?.content).toBe(
      "install v2",
    );
    expect(reviews.change("source/webhooks/index.mdx")?.content).toBe(
      "webhooks",
    );
    expect(reviews.change("source/pricing/index.mdx")?.kind).toBe("delete");
    expect(reviews.change("manifest.json")?.content).not.toContain("/pricing");
  });

  test("opens no review when the run changes no page", async () => {
    const { reviews, service, scope } = setup(PUBLISHED);

    await expect(service.openForRun("job-1")).resolves.toBe("unchanged");
    expect(await service.get(scope)).toBeNull();
    expect(reviews.events).toEqual(["unchanged:job-1"]);
  });

  test("a repeated completion keeps the review it opened", async () => {
    const { service } = setup();

    await service.openForRun("job-1");

    await expect(service.openForRun("job-1")).resolves.toBe("already_open");
  });

  test("keeps a removed page in the page and the navigation when a person rejects the removal", async () => {
    const { reviews, service, scope } = setup();
    await service.openForRun("job-1");

    const review = await service.decide(scope, {
      decisions: [{ href: "/pricing", decision: "rejected" }],
    });

    expect(review.pages.find((page) => page.href === "/pricing")?.decision).toBe(
      "rejected",
    );
    expect(reviews.change("source/pricing/index.mdx")).toBeUndefined();
    expect(reviews.change("manifest.json")?.content).toContain("/pricing");
  });

  test("a newer run keeps decisions and a person's edits", async () => {
    const { reviews, service, scope } = setup();
    await service.openForRun("job-1");
    await service.decide(scope, {
      decisions: [{ href: "/webhooks", decision: "rejected" }],
    });
    reviews.editByPerson("/install", "install edited by a person");

    await expect(service.openForRun("job-2")).resolves.toBe("opened");
    const review = await service.get(scope);

    expect(review?.jobId).toBe("job-2");
    expect(review?.createsBackup).toBe(true);
    expect(review?.pages.find((page) => page.href === "/webhooks")?.decision).toBe(
      "rejected",
    );
    expect(reviews.change("source/webhooks/index.mdx")).toBeUndefined();
    expect(reviews.change("source/install/index.mdx")).toMatchObject({
      origin: "editor",
      content: "install edited by a person",
    });
  });

  test("publishes the generation's changes without a decision on each page", async () => {
    const { service, published, scope } = setup();
    await service.openForRun("job-1");
    const review = await service.get(scope);

    await expect(
      service.publish(scope, {
        expectedBaseVersionId: MAIN_VERSION_ID,
        expectedRevision: review?.branch?.revision ?? 0,
      }),
    ).resolves.toEqual({
      versionId: "30000000-0000-4000-8000-000000000001",
      backupBranchName: "backup-2026-10-11",
    });
    expect(published).toEqual([
      expect.objectContaining({
        userId: OWNER_ID,
        branch: BRANCH_ID,
        request: expect.objectContaining({ eraseBranch: true }),
      }),
    ]);
  });

  test("starts a page that a person locked with the generation's change", async () => {
    const { reviews, service, scope } = setup();
    reviews.locks = [{ href: "/install" }, { href: "/pricing" }];

    await service.openForRun("job-1");
    const review = await service.get(scope);

    expect(
      review?.pages.map(({ href, decision, reasons }) => ({
        href,
        decision,
        owned: reasons.some((reason) => reason.kind === "owned_by_person"),
      })),
    ).toEqual([
      { href: "/install", decision: "accepted", owned: true },
      { href: "/webhooks", decision: "accepted", owned: false },
      { href: "/pricing", decision: "accepted", owned: true },
    ]);
    expect(reviews.change("source/install/index.mdx")?.content).toBe("install v2");
    expect(reviews.change("source/pricing/index.mdx")?.kind).toBe("delete");
  });

  test("opens a review for flags alone and shows them", async () => {
    const { service, scope } = setup(PUBLISHED);
    const flags = [
      { href: "/install", title: "Install", changedPaths: ["src/install.ts"] },
    ];

    await expect(
      service.openForRun("job-1", { ownedPageFlags: flags }),
    ).resolves.toBe("opened");
    const review = await service.get(scope);

    expect(review?.pages).toEqual([]);
    expect(review?.ownedPageFlags).toEqual(flags);
  });

  test("removes the hand-written pages that a seeded run left out", async () => {
    const { reviews, service, scope } = setup(SEEDED);

    await service.openForRun("job-1", {
      pageSources: [{ href: "/install", paths: ["src/install.ts"] }],
    });
    const review = await service.get(scope);
    const page = (href: string) => review?.pages.find((entry) => entry.href === href);

    expect(page("/pricing")).toMatchObject({
      change: "removed",
      decision: "accepted",
      decidedAt: null,
      reasons: [{ kind: "missing_from_generation" }],
    });
    expect(page("/install")?.reasons).toEqual([
      { kind: "content_rewritten" },
      {
        kind: "seed_conflicts",
        items: ["Install runs `make` -> the source uses `pnpm build` (Makefile)"],
      },
      { kind: "based_on_sources", paths: ["src/install.ts"] },
    ]);
    expect(reviews.change("source/install/index.mdx")?.content).toBe(
      "install v2\n",
    );
    expect(reviews.change("source/pricing/index.mdx")?.kind).toBe("delete");
  });

  test("follows a new page that a person renamed through later decisions", async () => {
    const { reviews, service, scope, store } = setup();
    await service.openForRun("job-1");
    await reviews.renameByPerson(store, { href: "/webhooks", slug: "hooks", title: "Hooks" });

    const decided = await service.decide(scope, {
      decisions: [{ href: "/pricing", decision: "rejected" }],
    });

    expect(decided.pages.find((page) => page.href === "/webhooks")?.branchHref).toBe("/hooks");
    expect(reviews.change("manifest.json")?.content).toContain("/hooks");
    expect(reviews.change("manifest.json")?.content).not.toContain("/webhooks");
    expect(reviews.change("source/hooks/index.mdx")).toMatchObject({
      origin: "editor",
      content: "webhooks",
    });

    const skipped = await service.decide(scope, {
      decisions: [{ href: "/webhooks", decision: "rejected" }],
    });

    expect(skipped.pages.find((page) => page.href === "/webhooks")?.branchHref).toBe(
      "/webhooks",
    );
    expect(reviews.change("source/hooks/index.mdx")).toBeUndefined();
    expect(reviews.change("manifest.json")?.content).not.toContain("/hooks");

    await service.decide(scope, {
      decisions: [{ href: "/webhooks", decision: "accepted" }],
    });
    expect(reviews.change("source/webhooks/index.mdx")?.content).toBe("webhooks");
    expect(reviews.change("manifest.json")?.content).toContain("/webhooks");
  });

  test("a newer run keeps a page where a person renamed it", async () => {
    const { reviews, service, scope, store } = setup();
    await service.openForRun("job-1");
    await reviews.renameByPerson(store, { href: "/webhooks", slug: "hooks", title: "Hooks" });

    await expect(service.openForRun("job-2")).resolves.toBe("opened");
    const review = await service.get(scope);

    expect(review?.pages.find((page) => page.href === "/webhooks")?.branchHref).toBe("/hooks");
    expect(reviews.change("manifest.json")?.content).toContain("/hooks");
    expect(reviews.change("manifest.json")?.content).not.toContain("/webhooks");
    expect(reviews.change("source/hooks/index.mdx")?.content).toBe("webhooks");
    expect(reviews.change("source/webhooks/index.mdx")?.kind).toBe("delete");
  });

  test("takes a decision back to the decision the page started with", async () => {
    const { reviews, service, scope } = setup();
    await service.openForRun("job-1");
    await service.decide(scope, {
      decisions: [
        { href: "/webhooks", decision: "rejected" },
        { href: "/pricing", decision: "rejected" },
      ],
    });

    const review = await service.decide(scope, {
      decisions: [
        { href: "/webhooks", decision: "undecided" },
        { href: "/pricing", decision: "undecided" },
      ],
    });
    const page = (href: string) => review.pages.find((entry) => entry.href === href);

    expect(page("/webhooks")).toMatchObject({ decision: "accepted", decidedAt: null });
    expect(page("/pricing")).toMatchObject({ decision: "accepted", decidedAt: null });
    expect(reviews.change("source/webhooks/index.mdx")?.content).toBe("webhooks");
    expect(reviews.change("source/pricing/index.mdx")?.kind).toBe("delete");
    expect(reviews.change("manifest.json")?.content).not.toContain("/pricing");
  });

  test("asks before taking back a kept removal that a person edited", async () => {
    const { reviews, service, scope } = setup();
    await service.openForRun("job-1");
    await service.decide(scope, { decisions: [{ href: "/pricing", decision: "rejected" }] });
    reviews.editByPerson("/pricing", "pricing edited by a person");
    const takeBack = { decisions: [{ href: "/pricing", decision: "undecided" as const }] };

    await expect(service.decide(scope, takeBack)).rejects.toMatchObject({
      code: "page_edited",
      details: { hrefs: ["/pricing"] },
    });
    expect(reviews.change("source/pricing/index.mdx")).toMatchObject({
      origin: "editor",
      content: "pricing edited by a person",
    });

    const review = await service.decide(scope, { ...takeBack, discardEdits: true });

    expect(review.pages.find((page) => page.href === "/pricing")).toMatchObject({
      decision: "accepted",
      decidedAt: null,
    });
    expect(reviews.change("source/pricing/index.mdx")?.kind).toBe("delete");
    expect(reviews.change("manifest.json")?.content).not.toContain("/pricing");
  });

  test("asks before a decision removes a page that a person edited", async () => {
    const { reviews, service, scope } = setup();
    await service.openForRun("job-1");
    reviews.editByPerson("/webhooks", "webhooks edited by a person");
    const discard = { decisions: [{ href: "/webhooks", decision: "rejected" as const }] };

    await expect(service.decide(scope, discard)).rejects.toMatchObject({
      code: "page_edited",
      details: { hrefs: ["/webhooks"] },
    });
    expect(reviews.change("source/webhooks/index.mdx")?.content).toBe("webhooks edited by a person");

    const review = await service.decide(scope, { ...discard, discardEdits: true });

    expect(review.pages.find((page) => page.href === "/webhooks")?.decision).toBe("rejected");
    expect(reviews.change("source/webhooks/index.mdx")).toBeUndefined();
    expect(reviews.change("manifest.json")?.content).not.toContain("/webhooks");
  });

  test("returns a page that a person locked to the generation's change when undecided", async () => {
    const { reviews, service, scope } = setup();
    reviews.locks = [{ href: "/install" }];
    await service.openForRun("job-1");
    await service.decide(scope, { decisions: [{ href: "/install", decision: "rejected" }] });
    expect(reviews.change("source/install/index.mdx")).toBeUndefined();

    const review = await service.decide(scope, {
      decisions: [{ href: "/install", decision: "undecided" }],
    });

    expect(review.pages.find((page) => page.href === "/install")).toMatchObject({
      decision: "accepted",
      decidedAt: null,
    });
    expect(reviews.change("source/install/index.mdx")?.content).toBe("install v2");
  });

  test("rejects a decision for a page outside the review", async () => {
    const { service, scope } = setup();
    await service.openForRun("job-1");

    await expect(
      service.decide(scope, {
        decisions: [{ href: "/unknown", decision: "accepted" }],
      }),
    ).rejects.toMatchObject({ code: "invalid" });
  });

  test("discards the open review", async () => {
    const { service, scope } = setup();
    await service.openForRun("job-1");

    await service.discard(scope);

    expect(await service.get(scope)).toBeNull();
    await expect(service.discard(scope)).rejects.toMatchObject({
      code: "not_found",
    });
  });
});
