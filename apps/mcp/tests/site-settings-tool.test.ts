import { describe, expect, it } from "vitest";
import { siteConfigSchema } from "@doxahq/site-config";
import type { McpServices } from "../src/services/mcp-services";
import { BRANCH_ID, OWNER, overview, PROJECT_A } from "./support/fixtures";
import { createHarness, type HarnessOptions } from "./support/harness";
import { callTool, toolError } from "./support/tool-calls";

async function update(
  args: Record<string, unknown>,
  options: HarnessOptions = {},
) {
  const harness = createHarness(options);
  const client = await harness.connect("modern");
  const outcome = await callTool(client, "update_site_settings", {
    projectId: PROJECT_A,
    branch: BRANCH_ID,
    ...args,
  });
  return { harness, outcome };
}

function writtenConfig(harness: { written: Array<{ edits: readonly unknown[] }> }) {
  const [call] = harness.written;
  const [edit] = call?.edits ?? [];
  return edit;
}

function withWorkingConfig(input: Record<string, unknown>) {
  const workingConfig = siteConfigSchema.parse(input);
  return (fakes: McpServices): McpServices => ({
    ...fakes,
    docs: {
      ...fakes.docs,
      getOverview: async (actor, projectId, branch, options) => {
        const base = await fakes.docs.getOverview(actor, projectId, branch, options);
        return { ...base, siteConfig: { ...base.siteConfig, working: workingConfig } };
      },
    },
  });
}

describe("update_site_settings", () => {
  it("merges the patch into the editable settings and writes one set_site_config edit", async () => {
    const { harness, outcome } = await update({
      update: { mode: "merge_patch", patch: { theme: { primary: "#2563eb" } } },
    });
    expect(outcome.isError).toBe(false);
    expect(harness.written[0]?.actor).toEqual({ userId: OWNER, origin: "mcp" });
    const edit = writtenConfig(harness);
    expect(edit).toMatchObject({
      type: "set_site_config",
      config: {
        name: "Demo",
        theme: {
          primary: "#2563eb",
          tokens: { light: { primary: "#2563eb" } },
        },
      },
    });
    expect(outcome.structured).toMatchObject({
      siteConfig: { theme: { primary: "#2563eb" } },
    });
  });

  it("starts from the branch's working settings when it has them", async () => {
    const { harness } = await update(
      { update: { mode: "merge_patch", patch: { description: "New" } } },
      { services: withWorkingConfig({ name: "Working" }) },
    );
    expect(writtenConfig(harness)).toMatchObject({
      config: { name: "Working", description: "New" },
    });
  });

  it("removes a field with null, so it falls back to its default", async () => {
    const { harness } = await update(
      { update: { mode: "merge_patch", patch: { description: null } } },
      { services: withWorkingConfig({ name: "Demo", description: "Old" }) },
    );
    const edit = writtenConfig(harness);
    expect(edit).toMatchObject({ config: { name: "Demo" } });
    expect(edit).not.toMatchObject({ config: { description: "Old" } });
  });

  it("replaces the settings in replace mode without reading the branch", async () => {
    const { harness, outcome } = await update({
      update: { mode: "replace", config: { name: "Replaced" } },
    });
    expect(outcome.isError).toBe(false);
    expect(harness.calls.map((entry) => entry.method)).toEqual([
      // The ownership check (SEC-028) lists the branches; the settings are not read.
      "branches.list",
      "docs.applyEdits",
    ]);
    expect(writtenConfig(harness)).toMatchObject({ config: { name: "Replaced" } });
  });

  it("returns validation_failed with issues for an invalid result and writes nothing", async () => {
    const { harness, outcome } = await update({
      update: { mode: "merge_patch", patch: { theme: { defaultMode: "neon" } } },
    });
    expect(toolError(outcome).code).toBe("validation_failed");
    expect(outcome.structured).toMatchObject({
      error: { issues: [expect.objectContaining({ path: expect.stringContaining("defaultMode") })] },
    });
    expect(harness.written).toEqual([]);
  });

  it("rejects an unknown field", async () => {
    const { harness, outcome } = await update({
      update: { mode: "merge_patch", patch: { unknownField: true } },
    });
    expect(toolError(outcome).code).toBe("validation_failed");
    expect(harness.written).toEqual([]);
  });

  it("applies the poweredBy entitlement rule", async () => {
    const { harness, outcome } = await update({
      update: { mode: "merge_patch", patch: { branding: { poweredBy: false } } },
    });
    expect(outcome.structured).toMatchObject({
      error: {
        code: "validation_failed",
        issues: [{ code: "entitlement_required", path: "/branding/poweredBy" }],
      },
    });
    expect(harness.written).toEqual([]);
  });

  it("rejects an asset reference that does not exist", async () => {
    const { outcome } = await update({
      update: {
        mode: "merge_patch",
        patch: { branding: { favicon: "asset:0123456789abcdef0123456789abcdef" } },
      },
    });
    expect(outcome.structured).toMatchObject({
      error: {
        code: "validation_failed",
        issues: [expect.objectContaining({ path: "/branding/favicon" })],
      },
    });
  });

  it("guards a merge patch with the revision it read", async () => {
    const { harness } = await update(
      { update: { mode: "merge_patch", patch: { name: "Late" } } },
      {
        services: (fakes) => ({
          ...fakes,
          docs: {
            ...fakes.docs,
            getOverview: async () => ({
              ...overview(PROJECT_A),
              working: { ...overview(PROJECT_A).working, revision: 1 },
            }),
          },
        }),
      },
    );
    expect(harness.written).toEqual([]);
  });

  it("maps a stale expectedRevision to conflict", async () => {
    const { outcome } = await update({
      update: { mode: "replace", config: { name: "X" } },
      expectedRevision: 9,
    });
    expect(toolError(outcome)).toMatchObject({
      code: "conflict",
      details: { currentRevision: 2 },
    });
  });
});
