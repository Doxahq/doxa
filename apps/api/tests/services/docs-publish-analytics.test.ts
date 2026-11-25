import { describe, expect, test } from "vitest";
import { publishViaOf, reportDocsPublished } from "../../src/services/docs-branches/publish-analytics";
import { recordingProductAnalytics } from "../support/recording-product-analytics";

describe("docs_published", () => {
  test("names the surface: a review, an agent, or the dashboard", () => {
    expect(publishViaOf({ review: { backupBranchName: null } })).toBe("review");
    expect(publishViaOf({ attribution: { agentClientId: "client-1", agentClientName: "Claude" }, review: null })).toBe("mcp");
    expect(publishViaOf({ review: null })).toBe("web");
  });

  test("reports whether the site had a branch publication before", async () => {
    const recording = recordingProductAnalytics();
    reportDocsPublished(
      { analytics: recording.analytics, isFirst: async (siteId) => siteId === "site-1" },
      { userId: "user-1", projectId: "project-1", siteId: "site-1", via: "web" },
    );
    expect(await recording.events()).toEqual([
      {
        kind: "event",
        event: "docs_published",
        distinctId: "user-1",
        properties: { first_publish: true, via: "web" },
        groups: { project: "project-1" },
      },
    ]);
  });
});
