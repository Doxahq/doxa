import { describe, expect, it } from "vitest";
import { checkMdxSource } from "@doxahq/api/services/docs-content/mdx-check";
import { DOXA_SERVER_INSTRUCTIONS } from "../src/instructions";
import { MDX_COMPONENT_GUIDES } from "../src/resources/mdx-component-guide";
import {
  authorableComponentNames,
  MDX_REFERENCE_URI,
} from "../src/resources/mdx-reference";
import { PROMPTS } from "../src/prompts";
import { TOOLS } from "../src/tools";
import { PROJECT_A } from "./support/fixtures";
import { createHarness } from "./support/harness";

describe("doxa://reference/mdx", () => {
  it("is public, cacheable markdown for any token", async () => {
    const client = await createHarness({ scopes: [] }).connect("modern");
    const listed = await client.listResources();
    expect(listed.resources).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ uri: MDX_REFERENCE_URI, mimeType: "text/markdown" }),
      ]),
    );
    const result = await client.readResource({ uri: MDX_REFERENCE_URI });
    const [content] = result.contents;
    const text = content && "text" in content ? content.text : "";
    for (const name of authorableComponentNames()) expect(text).toContain(`\`${name}\``);
  });

  it("documents exactly the components the renderer supports", () => {
    const documented = MDX_COMPONENT_GUIDES.flatMap((guide) => guide.names);
    expect([...documented].sort()).toEqual([...authorableComponentNames()].sort());
  });

  it.each(MDX_COMPONENT_GUIDES.filter((guide) => guide.example))(
    "has an example for $title that passes the MDX check",
    (guide) => {
      const page = `---\ntitle: Example\n---\n\n${guide.example}\n`;
      expect(checkMdxSource(page)).toEqual([]);
    },
  );
});

describe("main reads the live site", () => {
  async function read(name: string, args: Record<string, unknown>) {
    const harness = createHarness();
    const client = await harness.connect("modern");
    const result = await client.callTool({ name, arguments: { projectId: PROJECT_A, ...args } });
    return { harness, result };
  }

  it.each(["get_docs_structure", "get_site_settings"])(
    "%s asks for the published view on main",
    async (name) => {
      const { harness } = await read(name, {});
      expect(harness.calls).toEqual([
        expect.objectContaining({ method: "docs.getOverview", published: true }),
      ]);
    },
  );

  it("read_page returns the published content and revision 0 on main", async () => {
    const { harness, result } = await read("read_page", { href: "/install" });
    expect(result.structuredContent).toMatchObject({
      content: "# Install\n\nPublished.",
      status: "published",
      revision: 0,
    });
    expect(harness.calls).toEqual([
      expect.objectContaining({ method: "docs.getPage", published: true }),
    ]);
  });

  it("a branch read includes the branch's changes", async () => {
    const { harness } = await read("get_docs_structure", {
      branch: "55555555-5555-4555-8555-555555555555",
    });
    expect(harness.calls).toEqual([
      expect.objectContaining({ method: "docs.getOverview", published: false }),
    ]);
  });

  it("the page resource reads the published view", async () => {
    const harness = createHarness();
    const client = await harness.connect("modern");
    await client.readResource({ uri: `doxa://projects/${PROJECT_A}/pages/install` });
    expect(harness.calls).toEqual([
      expect.objectContaining({ method: "docs.getPage", published: true }),
    ]);
  });
});

describe("server instructions", () => {
  it("name only tools and prompts that exist, plus the approval outcome", () => {
    const names = new Set([
      ...TOOLS.map((tool) => tool.name),
      ...PROMPTS.map((prompt) => prompt.name),
    ]);
    const mentioned = DOXA_SERVER_INSTRUCTIONS.match(/\b[a-z]+(?:_[a-z]+)+\b/g) ?? [];
    const unknown = mentioned.filter((name) => !names.has(name));
    expect(new Set(unknown)).toEqual(
      new Set(["approval_required"]),
    );
  });
});
