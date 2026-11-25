import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, test, vi } from "vitest";

import {
  createMermaid,
  Embed,
  createPre,
  Tabs,
  TabsContent,
  TabsList,
  TabsTrigger,
} from "../src";

const Icon = ({ className }: { className?: string }) => <i className={className} />;
const Pre = createPre({ copy: Icon, copied: Icon });

describe("code fence", () => {
  test("shows the language before the copy control", () => {
    const html = renderToStaticMarkup(
      <Pre raw="const ready = true;" data-language="typescript">
        <code>const ready = true;</code>
      </Pre>,
    );
    expect(html).toContain('data-code-language="true"');
    expect(html.indexOf(">typescript</span>")).toBeLessThan(
      html.indexOf('aria-label="Copy to clipboard"'),
    );
    expect(html).toContain('<pre data-language="typescript"><code>');
  });

  test("leaves out the copy control without source text", () => {
    const html = renderToStaticMarkup(
      <Pre data-language="text">
        <code>visible code</code>
      </Pre>,
    );
    expect(html).not.toContain("Copy to clipboard");
  });
});

describe("tabs", () => {
  test("renders the active panel with its trigger", () => {
    const html = renderToStaticMarkup(
      <Tabs defaultValue="npm">
        <TabsList>
          <TabsTrigger value="npm">npm</TabsTrigger>
          <TabsTrigger value="pnpm">pnpm</TabsTrigger>
        </TabsList>
        <TabsContent value="npm">npm install</TabsContent>
        <TabsContent value="pnpm">pnpm add</TabsContent>
      </Tabs>,
    );
    expect(html).toContain('data-slot="tabs"');
    expect(html).toContain("npm install");
    expect(html).not.toContain("pnpm add");
  });
});

describe("diagram", () => {
  test("draws the host's SVG into the server HTML, with scoped ids", () => {
    const render = vi.fn((_text: string, options?: { idPrefix?: string }) => ({
      svg: `<svg aria-labelledby="${options?.idPrefix}title"><title id="${options?.idPrefix}title">Build</title><g id="A"><path marker-end="url(#A)"/></g><a href="#install">Install</a></svg>`,
    }));
    const Mermaid = createMermaid({ render });
    const html = renderToStaticMarkup(<Mermaid chart={"graph TD\nA-->B"} />);
    expect(render).toHaveBeenCalledTimes(1);
    const prefix = render.mock.calls[0][1]?.idPrefix ?? "";
    expect(prefix).toMatch(/^doxa-mermaid-[a-zA-Z0-9_-]+-$/);
    expect(html).toContain('data-state="rendered"');
    expect(html).toContain("doxa-mermaid not-prose");
    expect(html).toContain(`id="${prefix}A"`);
    expect(html).toContain(`url(#${prefix}A)`);
    expect(html).toContain(`aria-labelledby="${prefix}title"`);
    // A link to a page anchor keeps its target.
    expect(html).toContain('href="#install"');
  });

  test("shows the parse error in place of the diagram", () => {
    const Mermaid = createMermaid({
      render: () => {
        throw new Error("Parse error on line 2");
      },
    });
    const html = renderToStaticMarkup(<Mermaid chart={"flowchart LR\n  A -->"} />);
    expect(html).toContain('data-state="error"');
    expect(html).toContain("This diagram could not be drawn.");
    expect(html).toContain("Parse error on line 2");
  });
});

describe("embed", () => {
  test("plays a supported video in a lazy iframe", () => {
    const html = renderToStaticMarkup(
      <Embed url="https://youtu.be/dQw4w9WgXcQ" title="Quick start" />,
    );
    expect(html).toContain(
      'src="https://www.youtube-nocookie.com/embed/dQw4w9WgXcQ"',
    );
    expect(html).toContain('title="Quick start"');
    expect(html).toContain('loading="lazy"');
  });

  test("renders any other address as a link, never an iframe", () => {
    const html = renderToStaticMarkup(<Embed url="https://example.com/video" />);
    expect(html).not.toContain("<iframe");
    expect(html).toContain('href="https://example.com/video"');
  });

  test("renders nothing for an address that is not http", () => {
    expect(renderToStaticMarkup(<Embed url="javascript:alert(1)" />)).toBe("");
  });
});
