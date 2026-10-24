import { join, relative } from "node:path";
import { describe, expect, test } from "vitest";
import { createHostedWorkspaceLayout } from "../src/workspace-layout";

describe("hosted workspace layout", () => {
  test("keeps writable artifacts outside the untrusted checkout", () => {
    const layout = createHostedWorkspaceLayout(
      "/srv/doxa",
      "11111111-1111-4111-8111-111111111111",
    );

    expect(layout.checkoutRoot).toBe(
      "/srv/doxa/.workspaces/11111111-1111-4111-8111-111111111111/checkout",
    );
    expect(layout.outputRoot).toBe(join(layout.artifactRoot, "docs"));
    expect(relative(layout.checkoutRoot, layout.artifactRoot)).toMatch(/^\.\./);
    expect(relative(layout.artifactRoot, layout.checkoutRoot)).toMatch(/^\.\./);
  });

  test.each([
    "../outside",
    "job/write-target",
    "",
  ])("rejects unsafe workspace identifier %j", (workspaceId) => {
    expect(() => createHostedWorkspaceLayout("/srv/doxa", workspaceId))
      .toThrow("Invalid hosted workspace identifier.");
  });

  test("shares an exact checkout across isolated generation stages", () => {
    const analysis = createHostedWorkspaceLayout(
      "/srv/doxa",
      "11111111-1111-4111-8111-111111111111",
      "analysis",
    );
    const structure = createHostedWorkspaceLayout(
      "/srv/doxa",
      "11111111-1111-4111-8111-111111111111",
      "structure",
    );

    expect(analysis.checkoutRoot).toBe(structure.checkoutRoot);
    expect(analysis.snapshotRoot).toBe(structure.snapshotRoot);
    expect(analysis.stageRoot).not.toBe(structure.stageRoot);
    expect(relative(analysis.checkoutRoot, analysis.artifactRoot)).toMatch(
      /^\.\./,
    );
  });

  test("isolates concurrent executions of the same stage", () => {
    const first = createHostedWorkspaceLayout(
      "/srv/doxa",
      "11111111-1111-4111-8111-111111111111",
      "write-22222222-2222-4222-8222-222222222222",
    );
    const second = createHostedWorkspaceLayout(
      "/srv/doxa",
      "11111111-1111-4111-8111-111111111111",
      "write-33333333-3333-4333-8333-333333333333",
    );

    expect(first.stageRoot).not.toBe(second.stageRoot);
    expect(first.artifactRoot).not.toBe(second.artifactRoot);
    expect(first.snapshotRoot).toBe(second.snapshotRoot);
    expect(first.checkoutRoot).toBe(second.checkoutRoot);
  });

  test.each([
    "../write",
    "write/execution",
    "",
  ])("rejects unsafe stage identifier %j", (stageId) => {
    expect(() =>
      createHostedWorkspaceLayout(
        "/srv/doxa",
        "11111111-1111-4111-8111-111111111111",
        stageId,
      )
    ).toThrow("Invalid hosted stage identifier.");
  });
});
