import { createElement, type ReactNode } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, test } from "vitest";
import { parseRuntimeMdx } from "@doxahq/mdx-runtime";

import { createProseComponents } from "../src/components/registry";
import { RuntimeMdxContent } from "../src/render/runtime-mdx-content";

function render(source: string, components = createProseComponents()): string {
  return renderToStaticMarkup(
    createElement(RuntimeMdxContent, {
      document: parseRuntimeMdx(source),
      components,
    }),
  );
}

describe("prose rendering", () => {
  test("renders a markdown image as a lazy img", () => {
    const html = render("![Diagram](/assets/diagram.png)\n");

    expect(html).toContain(
      '<img src="/assets/diagram.png" alt="Diagram" loading="lazy" decoding="async"/>',
    );
  });

  test("draws a plain element through its replacement when one is given", () => {
    const Image = (props: { src?: string }) =>
      createElement("img", { "data-replaced": "", src: `${props.src}#x` });
    const html = renderToStaticMarkup(
      createElement(RuntimeMdxContent, {
        document: parseRuntimeMdx("![a](/assets/a.png)\n"),
        components: createProseComponents(),
        elements: { img: Image },
      }),
    );

    expect(html).toContain('<img data-replaced="" src="/assets/a.png#x"/>');
  });

  test("renders markdown structure", () => {
    const html = render("# Title\n\nSome **bold** text.\n");

    expect(html).toContain('<h1 id="title">Title</h1>');
    expect(html).toContain("<strong>bold</strong>");
  });

  test("renders a note with its variant styling", () => {
    const html = render('<Note type="warning" title="Heads up">\nCareful.\n</Note>\n');

    expect(html).toContain("Heads up:");
    expect(html).toContain("bg-orange-100");
  });

  test("numbers each step once, even without blank lines between the items", () => {
    const html = render(
      [
        "<Step>",
        '<StepItem title="Install">Add it.</StepItem>',
        '<StepItem title="Run">Run it.</StepItem>',
        "</Step>",
      ].join("\n"),
    );

    // The two numbers prove the paragraph wrapper was removed before counting.
    expect(html).toContain(">1</div>");
    expect(html).toContain(">2</div>");
    expect(html).not.toContain(">3</div>");
  });

  test("never nests a block component inside a paragraph", () => {
    const html = render(
      ["<CardGrid>", '<Card title="One">a</Card>', '<Card title="Two">b</Card>', "</CardGrid>"].join(
        "\n",
      ),
    );

    expect(html).not.toContain("<p><div");
  });

  test("keeps an inline component inside its sentence", () => {
    const html = render("See <Note>this</Note> for details.\n");
    expect(html).toContain("<p>See ");
  });

  test("routes links through the injected link component", () => {
    function TaggedLink({ href, children }: { href?: string; children?: ReactNode }) {
      return createElement("a", { "data-routed": "true", href }, children);
    }

    const html = render(
      "[docs](/guide)\n",
      createProseComponents({ link: TaggedLink }),
    );
    expect(html).toContain('data-routed="true"');
    expect(html).toContain('href="/guide"');
  });

  test("resolves a card icon through the injected resolver", () => {
    function Icon({ className }: { className?: string }) {
      return createElement("svg", { className, "data-icon": "true" });
    }

    const html = render(
      '<Card title="Guide" icon="book" />\n',
      createProseComponents({ resolveIcon: (name) => (name === "book" ? Icon : null) }),
    );
    expect(html).toContain('data-icon="true"');
  });

  test("draws a card icon on the title's line, before the title", () => {
    function Icon({ className }: { className?: string }) {
      return createElement("svg", { className, "data-icon": "true" });
    }

    const html = render(
      '<Card title="Guide" icon="book" description="Read it." />\n',
      createProseComponents({ resolveIcon: () => Icon }),
    );
    // One row: the icon, then the title, centered on each other.
    expect(html).toMatch(/<div class="flex items-center gap-2"><svg class="[^"]*size-5[^"]*" data-icon="true"><\/svg><div class="[^"]*text-lg[^"]*">Guide<\/div><\/div>/);
    expect(html.indexOf("Guide")).toBeLessThan(html.indexOf("Read it."));
  });

  test("a linked card tints on hover, without motion; a card without a link does not", () => {
    const linked = render('<Card title="Guide" href="/guide" external={true} />\n', createProseComponents({ externalIcon: () => createElement("svg") }))
    expect(linked).toContain("hover:bg-muted/50")
    expect(linked).not.toMatch(/group-hover:|hover:shadow|transition-|translate-/)
    expect(render('<Card title="Plain" />\n', createProseComponents())).not.toContain("hover:")
  })

  test("an override replaces the shared component", () => {
    function LoudNote({ children }: { children?: ReactNode }) {
      return createElement("div", { "data-loud": "true" }, children);
    }

    const html = render(
      "<Note>hello</Note>\n",
      createProseComponents({ overrides: { Note: LoudNote } }),
    );
    expect(html).toContain('data-loud="true"');
    expect(html).not.toContain("bg-secondary");
  });

  // A component name outside the runtime vocabulary is rejected while parsing,
  // before the renderer sees it. A live editor must therefore treat a parse
  // failure, not a render failure, as the "unknown component" case.
  test("the parser rejects a component name it does not know", () => {
    expect(() => parseRuntimeMdx("<Mystery>x</Mystery>\n")).toThrow(
      /Unknown MDX component: Mystery/,
    );
  });

  test("throws when a known component is missing from the map", () => {
    const withoutNote = createProseComponents();
    delete withoutNote.Note;

    expect(() => render("<Note>x</Note>\n", withoutNote)).toThrow(
      /Unknown MDX component: Note/,
    );
  });

  test("uses the fallback component instead of throwing when one is given", () => {
    const withoutNote = createProseComponents();
    delete withoutNote.Note;

    const html = renderToStaticMarkup(
      createElement(RuntimeMdxContent, {
        document: parseRuntimeMdx("<Note>x</Note>\n"),
        components: withoutNote,
        fallbackComponent: ({ children }: { children?: ReactNode }) =>
          createElement("div", { "data-unknown": "true" }, children),
      }),
    );

    expect(html).toContain('data-unknown="true"');
  });
});

describe("file tree", () => {
  const icons = {
    folderOpen: () => createElement("svg", { "data-icon": "folder-open" }),
    folderClosed: () => createElement("svg", { "data-icon": "folder-closed" }),
    file: () => createElement("svg", { "data-icon": "file" }),
  }

  test("is left unregistered when no icons are supplied", () => {
    expect(createProseComponents().FileTree).toBeUndefined()
  })

  test("registers the tree when icons are supplied", () => {
    const components = createProseComponents({ fileTreeIcons: icons })
    expect(components.FileTree).toBeDefined()
    expect(components.Folder).toBeDefined()
    expect(components.File).toBeDefined()
  })

  test("draws an icon for every folder and file", () => {
    const html = render(
      [
        "<FileTree>",
        '<Folder name="src" defaultOpen>',
        '<File name="index.ts" />',
        "</Folder>",
        '<File name="package.json" />',
        "</FileTree>",
      ].join("\n"),
      createProseComponents({ fileTreeIcons: icons }),
    )

    expect(html).toContain('data-icon="folder-open"')
    expect((html.match(/data-icon="file"/g) ?? []).length).toBe(2)
    expect(html).toContain("index.ts")
    expect(html).toContain("package.json")
  })

  test("uses the closed icon for a collapsed folder", () => {
    const html = render(
      ["<FileTree>", '<Folder name="src"><File name="a.ts" /></Folder>', "</FileTree>"].join("\n"),
      createProseComponents({ fileTreeIcons: icons }),
    )
    expect(html).toContain('data-icon="folder-closed"')
  })
})
