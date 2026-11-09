import { describe, expect, test } from "vitest";
import { projectOverviewSchema } from "@doxahq/contracts/project-overview";
import type {
  FinishedJobRow,
  ProjectOverviewRows,
  PublicationRow,
} from "../../src/repositories/project-overview";
import {
  PROJECT_ACTIVITY_LIMIT,
  buildProjectOverview,
} from "../../src/services/project-overview";

const JOB = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";
const AT = new Date("2026-11-09T10:00:00.000Z");
const toUrl = (hostname: string) => `https://${hostname}`;

function publication(overrides: Partial<PublicationRow> = {}): PublicationRow {
  return {
    id: "publication-1",
    kind: "generation",
    versionNumber: 42,
    createdAt: AT,
    summary: { changedPageCount: 6 },
    actorName: null,
    agentClientName: null,
    ...overrides,
  };
}

function job(overrides: Partial<FinishedJobRow> = {}): FinishedJobRow {
  return {
    id: JOB,
    status: "succeeded",
    publicationMode: "production",
    versionStatus: "published",
    pullRequestNumber: null,
    updatedAt: AT,
    ...overrides,
  };
}

function rows(overrides: Partial<ProjectOverviewRows> = {}): ProjectOverviewRows {
  return {
    publications: [],
    finishedJobs: [],
    cancelledBy: new Map(),
    agentActions: [],
    openPreviews: [],
    lastSyncedRevision: null,
    ...overrides,
  };
}

describe("the project overview", () => {
  test("names who published: an agent, then a person, then Doxabot", () => {
    const actors = [
      publication({ agentClientName: "Claude Code", actorName: "Maya" }),
      publication({ actorName: "Maya" }),
      publication(),
    ].map(
      (row) =>
        buildProjectOverview(rows({ publications: [row] }), toUrl).activity[0]
          ?.actor,
    );

    expect(actors).toEqual([
      { kind: "agent", name: "Claude Code" },
      { kind: "person", name: "Maya" },
      { kind: "doxabot", name: "Doxabot" },
    ]);
  });

  test("keeps the starter publication out of the feed, but reports it as the latest", () => {
    const overview = buildProjectOverview(
      rows({ publications: [publication({ kind: "starter" })] }),
      toUrl,
    );

    expect(overview.activity).toEqual([]);
    expect(overview.latestPublication?.kind).toBe("starter");
  });

  test("a run that published adds no second event", () => {
    const overview = buildProjectOverview(
      rows({ publications: [publication()], finishedJobs: [job()] }),
      toUrl,
    );

    expect(overview.activity.map((event) => event.type)).toEqual(["published"]);
  });

  test("a run that waits for review is its own event", () => {
    const overview = buildProjectOverview(
      rows({ finishedJobs: [job({ versionStatus: "staged" })] }),
      toUrl,
    );

    expect(overview.activity.map((event) => event.type)).toEqual([
      "generation_staged",
    ]);
  });

  test("a preview run names its pull request", () => {
    const overview = buildProjectOverview(
      rows({
        finishedJobs: [job({ publicationMode: "preview", pullRequestNumber: 418 })],
      }),
      toUrl,
    );

    expect(overview.activity[0]).toMatchObject({
      type: "preview_built",
      pullRequestNumber: 418,
    });
  });

  test("a cancel names the person, and Doxabot when Doxa stopped the run", () => {
    const [byPerson, byDoxa] = [new Map([[JOB, "Maya"]]), new Map()].map(
      (cancelledBy) =>
        buildProjectOverview(
          rows({ finishedJobs: [job({ status: "cancelled" })], cancelledBy }),
          toUrl,
        ).activity[0]?.actor,
    );

    expect(byPerson).toEqual({ kind: "person", name: "Maya" });
    expect(byDoxa).toEqual({ kind: "doxabot", name: "Doxabot" });
  });

  test("an agent action that a release removed stays out", () => {
    const overview = buildProjectOverview(
      rows({
        agentActions: [
          { id: "1", clientName: "Cursor", actionKind: "domain.add", occurredAt: AT },
          { id: "2", clientName: "Cursor", actionKind: "old.kind", occurredAt: AT },
        ],
      }),
      toUrl,
    );

    expect(overview.activity.map((event) => event.id)).toEqual(["agent:1"]);
  });

  test("merges the sources newest first and caps the feed", () => {
    const publications = Array.from({ length: 15 }, (_, index) =>
      publication({
        id: `p${index}`,
        createdAt: new Date(AT.getTime() - index * 2 * 60_000),
      }),
    );
    const agentActions = Array.from({ length: 15 }, (_, index) => ({
      id: `a${index}`,
      clientName: "Cursor",
      actionKind: "generation.start",
      occurredAt: new Date(AT.getTime() - (index * 2 + 1) * 60_000),
    }));

    const { activity } = buildProjectOverview(
      rows({ publications, agentActions }),
      toUrl,
    );

    expect(activity).toHaveLength(PROJECT_ACTIVITY_LIMIT);
    expect(activity.slice(0, 3).map((event) => event.id)).toEqual([
      "publication:p0",
      "agent:a0",
      "publication:p1",
    ]);
  });

  test("a preview without a site has no link, and the answer fits the contract", () => {
    const overview = buildProjectOverview(
      rows({
        publications: [publication()],
        lastSyncedRevision: "a1f93c2",
        openPreviews: [
          { pullRequestNumber: 7, status: "running", hostname: null, createdAt: AT, updatedAt: AT },
          { pullRequestNumber: 8, status: "succeeded", hostname: "pr-8.doxa.page", createdAt: AT, updatedAt: AT },
        ],
      }),
      toUrl,
    );

    expect(overview.openPreviews.map((preview) => preview.previewUrl)).toEqual([
      null,
      "https://pr-8.doxa.page",
    ]);
    expect(projectOverviewSchema.safeParse(overview).success).toBe(true);
  });
});
