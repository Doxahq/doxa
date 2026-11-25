import { memo, useId, useMemo, type ComponentType } from "react";

import { cn } from "../lib/cn";

export interface MermaidProps {
  chart: string;
  className?: string;
}

/** The options of Pele's `render` that the diagram sets. */
export interface DiagramRenderOptions {
  /** Keeps the marker and gradient ids of two diagrams on one page apart. */
  idPrefix?: string;
}

/**
 * The part of the `pele` package the diagram uses. Pele draws Mermaid text as
 * SVG, synchronously and with no DOM, so the server can draw the diagram.
 * `render` throws a `PeleError` for text it cannot draw.
 */
export interface DiagramRenderer {
  render(text: string, options?: DiagramRenderOptions): { svg: string };
}

type DrawResult = { svg: string; error?: undefined } | { svg?: undefined; error: string };

function escapeRegExp(value: string) {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

/**
 * Puts the prefix on every id the SVG defines. Pele 1.13 prefixes its title,
 * markers and gradients, but not the ids of nodes and edges (`id="A"`). Those
 * would repeat when two diagrams on a page use the same node names, and could
 * take a heading's anchor. References inside the SVG move with the ids. Links
 * to page anchors keep their targets, unless the SVG itself defines that id.
 */
export function scopeSvgIds(svg: string, prefix: string): string {
  const ids = new Set<string>();
  for (const match of svg.matchAll(/\sid="([^"]+)"/g)) {
    if (!match[1].startsWith(prefix)) ids.add(match[1]);
  }
  if (ids.size === 0) return svg;
  const names = [...ids].map(escapeRegExp).join("|");
  return svg
    .replace(new RegExp(`(\\sid=")(${names})"`, "g"), `$1${prefix}$2"`)
    .replace(new RegExp(`url\\(#(${names})\\)`, "g"), `url(#${prefix}$1)`)
    .replace(new RegExp(`(href=")#(${names})"`, "g"), `$1#${prefix}$2"`)
    .replace(
      new RegExp(`(aria-(?:labelledby|describedby)=")([^"]*)"`, "g"),
      (_, start: string, list: string) =>
        `${start}${list
          .split(/\s+/)
          .map((id) => (ids.has(id) ? prefix + id : id))
          .join(" ")}"`,
    );
}

function draw(renderer: DiagramRenderer, chart: string, idPrefix: string): DrawResult {
  try {
    return { svg: scopeSvgIds(renderer.render(chart, { idPrefix }).svg, idPrefix) };
  } catch (error) {
    return { error: error instanceof Error ? error.message : String(error) };
  }
}

/**
 * Builds the diagram component around the host's `pele` module.
 *
 * The module is passed in, so this package does not depend on it and each host
 * decides how it is loaded. Both hosts load it in a lazy chunk, so it loads
 * only on a page with a diagram.
 *
 * The diagram draws during render, so the server HTML holds the finished SVG
 * and the diagram shows with the first paint. Its colors and font are CSS
 * variables (`.doxa-mermaid` in `prose.css`), so a theme change needs no new
 * render.
 *
 * Pele measures text with a canvas in the browser, and with its own font
 * metrics on the server, so the two SVGs can differ by a few pixels. At
 * hydration the server SVG stays: React does not patch `dangerouslySetInnerHTML`
 * when it hydrates, and `suppressHydrationWarning` drops the dev warning. A
 * diagram that mounts later, after a client navigation or in the editor, uses
 * the browser's measurements.
 */
export function createMermaid(renderer: DiagramRenderer): ComponentType<MermaidProps> {
  const Mermaid = ({ chart, className }: MermaidProps) => {
    const idPrefix = `doxa-mermaid-${useId().replace(/[^a-zA-Z0-9_-]/g, "")}-`;
    const result = useMemo(() => draw(renderer, chart, idPrefix), [chart, idPrefix]);

    if (result.error !== undefined) {
      return (
        <div
          className={cn(
            "not-prose my-6 rounded-md border border-destructive/40 bg-destructive/5 p-4 text-sm",
            className,
          )}
          data-mermaid-chart
          data-state="error"
          role="note"
        >
          <p className="font-medium text-destructive">This diagram could not be drawn.</p>
          <pre className="mt-2 overflow-x-auto font-mono text-xs whitespace-pre-wrap text-muted-foreground">
            {result.error}
          </pre>
        </div>
      );
    }

    return (
      <div
        className={cn(
          "doxa-mermaid not-prose my-6 flex justify-center overflow-x-auto",
          className,
        )}
        data-mermaid-chart
        data-state="rendered"
        dangerouslySetInnerHTML={{ __html: result.svg }}
        suppressHydrationWarning
      />
    );
  };

  return memo(Mermaid);
}
