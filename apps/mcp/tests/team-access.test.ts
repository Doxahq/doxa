import { describe, expect, it } from "vitest";
import type { TeamRole } from "@doxahq/contracts/teams";
import { BRANCH_ID, OTHER, PROJECT_TEAM } from "./support/fixtures";
import { createHarness } from "./support/harness";
import { callTool, toolError } from "./support/tool-calls";

const VALID = "---\ntitle: Install\n---\n\n## Steps\n\nRun it.\n";

async function call(name: string, args: Record<string, unknown>, teamRole?: TeamRole) {
  const harness = createHarness({ teamRole });
  const client = await harness.connect("modern");
  const outcome = await callTool(client, name, { projectId: PROJECT_TEAM, ...args });
  return { harness, outcome };
}

const writePage = { branch: BRANCH_ID, href: "/install", content: VALID };

describe("team projects over MCP (spec §5, §12 q3)", () => {
  it("lets a viewer's agent read a team project, as the project owner's data", async () => {
    const { harness, outcome } = await call("read_page", { href: "/install", branch: BRANCH_ID }, "viewer");
    expect(outcome.structured).toMatchObject({ content: "# Install\n\nWorking." });
    // Storage stays with the project owner; the member only authorizes.
    expect(harness.calls).toContainEqual(expect.objectContaining({ method: "docs.getPage", userId: OTHER }));
  });

  it("answers not_found to a viewer agent's write and writes nothing", async () => {
    const { harness, outcome } = await call("write_page", writePage, "viewer");
    expect(toolError(outcome).code).toBe("not_found");
    expect(harness.written).toEqual([]);
  });

  it("lets an editor's agent write a team project", async () => {
    const { harness } = await call("write_page", writePage, "editor");
    expect(harness.written).toEqual([
      expect.objectContaining({ actor: { userId: OTHER, origin: "mcp" }, projectId: PROJECT_TEAM }),
    ]);
  });

  it("answers not_found to every call from a user who is not a member", async () => {
    const read = await call("read_page", { href: "/install", branch: BRANCH_ID });
    expect(toolError(read.outcome).code).toBe("not_found");
    const write = await call("write_page", writePage);
    expect(toolError(write.outcome).code).toBe("not_found");
    expect(write.harness.written).toEqual([]);
  });
});
