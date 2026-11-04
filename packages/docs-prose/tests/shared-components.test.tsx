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
  test("initializes the host's mermaid once and renders the loading state", () => {
    const mermaid = { initialize: vi.fn(), render: vi.fn() };
    const Mermaid = createMermaid(mermaid);
    const html = renderToStaticMarkup(<Mermaid chart={"graph TD\nA-->B"} />);
    expect(mermaid.initialize).toHaveBeenCalledTimes(1);
    expect(mermaid.initialize).toHaveBeenCalledWith({
      startOnLoad: false,
      theme: "neutral",
      securityLevel: "strict",
    });
    expect(html).toContain('data-state="loading"');
    expect(html).toContain("doxa-mermaid not-prose");
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
