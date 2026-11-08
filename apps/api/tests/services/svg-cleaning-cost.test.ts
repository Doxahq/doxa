import { describe, expect, test } from "vitest";

import { cleanSvg } from "../../src/services/site-assets/svg";

/**
 * SECURITY REGRESSION GUARDRAIL: every upload path (dashboard, upload_asset,
 * MCP upload URLs) cleans SVG on the request. The old in-place cleaning was
 * quadratic: 60,000 paths took 235 s. A file must clean in linear time, and
 * a small file must not ask a browser to draw millions of nodes through
 * `<use>`, markers, patterns, clip paths, or masks.
 */
const svg = (body: string) => `<svg xmlns="http://www.w3.org/2000/svg">${body}</svg>`;

function timed(input: string) {
  const started = performance.now();
  const result = cleanSvg(input, "docs_image");
  return { result, ms: performance.now() - started };
}

describe("SVG cleaning cost", () => {
  test.each([
    ["60k allowed siblings", svg('<path d="M0 0"/>'.repeat(60_000))],
    ["60k removed siblings", svg("<foo/>".repeat(60_000))],
    ["60k siblings with a removed attribute", svg('<path d="M0 0" onclick="x()"/>'.repeat(60_000))],
    ["200k nested groups", svg("<g>".repeat(200_000) + "</g>".repeat(200_000))],
    ["30k <use> elements of an ID that 30k elements share", svg('<g id="a"/>'.repeat(30_000) + '<use href="#a"/>'.repeat(30_000))],
    ["150k elements that share one ID", svg('<g id="a"/>'.repeat(150_000) + '<use href="#a"/>')],
    ["a 100k-step <use> chain", svg(Array.from({ length: 100_000 }, (_, i) => `<use id="u${i}" href="#u${i + 1}"/>`).join("") + '<g id="u100000"/>')],
  ])("cleans %s in linear time", (_name, input) => {
    // Linear work takes well under a second; the quadratic walk took minutes.
    expect(timed(input).ms).toBeLessThan(5_000);
  });
});

describe("reference rules: <use>", () => {
  test("keeps a chain of <use> elements that stays within the budget", () => {
    const input = svg(
      '<defs><g id="a"><path d="M0 0"/></g><g id="b"><use href="#a"/><use href="#a"/></g></defs><use href="#b"/><use href="#a"/>',
    );
    expect(cleanSvg(input, "docs_image")).toEqual({ svg: input, removedCount: 0 });
  });

  test("cuts a doubling chain before it reaches a billion copies", () => {
    let defs = '<g id="g0"><path d="M0 0"/></g>';
    for (let level = 1; level <= 30; level++) {
      defs += `<g id="g${level}"><use href="#g${level - 1}"/><use href="#g${level - 1}"/></g>`;
    }
    const { svg: output, removedCount } = timed(svg(`<defs>${defs}</defs><use href="#g30"/>`)).result;
    expect(removedCount).toBeGreaterThan(0);
    expect(output).not.toContain('<use href="#g30"/>');
    // A <use> of level k draws 2^k paths. Every kept one fits the budget.
    const kept = [...output.matchAll(/<use href="#g(\d+)"\/>/g)].map((match) => Number(match[1]));
    expect(kept.length).toBeGreaterThan(0);
    expect(2 ** Math.max(...kept)).toBeLessThanOrEqual(20_000);
  });

  test("cuts every <use> on a cycle", () => {
    const { svg: output } = cleanSvg(
      svg('<use id="u" href="#u"/><g id="a"><use href="#b"/></g><g id="b"><use href="#a"/></g><g id="c"><g><use href="#c"/></g></g>'),
      "docs_image",
    );
    expect(output).not.toContain('href="#u"/>');
    expect(output).not.toContain('<use href="#a"/>');
    expect(output).not.toContain('<use href="#b"/>');
    expect(output).not.toContain('<use href="#c"/>');
  });

  test("caps the nodes that all <use> elements clone together", () => {
    const group = `<g id="t">${'<path d="M0 0"/>'.repeat(999)}</g>`;
    const { svg: output, removedCount } = cleanSvg(svg(`<defs>${group}</defs>${'<use href="#t"/>'.repeat(100)}`), "docs_image");
    // Each use clones 1,000 nodes; the budget of 20,000 allows 20 of them.
    expect(output.match(/<use /g)).toHaveLength(20);
    expect(removedCount).toBe(80);
  });

  test("measures both href and xlink:href: a browser draws href", () => {
    const huge = `<g id="huge">${'<path d="M0 0"/>'.repeat(30_000)}</g>`;
    const { svg: output } = cleanSvg(
      svg(`<defs><g id="small"/>${huge}</defs><use xmlns:xlink="http://www.w3.org/1999/xlink" xlink:href="#small" href="#huge"/>`),
      "docs_image",
    );
    expect(output).not.toContain("<use");
  });

  test("measures every element of a shared ID: a cut first one hands the ID on", () => {
    // The first #t is a <use> on a cycle, so it is cut. A browser then
    // resolves #t to the large group.
    const huge = `<g id="t">${'<path d="M0 0"/>'.repeat(4_999)}</g>`;
    const { svg: output } = cleanSvg(
      svg(`<defs><use id="t" href="#t"/>${huge}</defs>${'<use href="#t"/>'.repeat(100)}`),
      "docs_image",
    );
    expect(output).not.toContain('<use id="t"');
    // #t costs as much as its costliest element, the group of 5,000 nodes:
    // 4 uses fit the budget. Measured against the first element only, all
    // 100 would stay and draw 500,000 nodes.
    expect(output.match(/<use href="#t"\/>/g)).toHaveLength(4);
  });

  test("keeps IDs that several elements share, as diagram tools export them", () => {
    const input = svg('<g id="node_1"><rect width="1" height="1"/></g><text id="node_1">a</text>');
    expect(cleanSvg(input, "docs_image")).toEqual({ svg: input, removedCount: 0 });
  });

  test("keeps a normal diagram with icons unchanged", () => {
    const input = svg(
      '<defs><symbol id="icon"><path d="M0 0"/></symbol></defs><use href="#icon" x="1"/><use href="#icon" x="2"/>',
    );
    expect(cleanSvg(input, "docs_image")).toEqual({ svg: input, removedCount: 0 });
  });

  test("leaves a <use> to a missing target alone; it renders nothing", () => {
    const input = svg('<use href="#missing"/>');
    expect(cleanSvg(input, "docs_image")).toEqual({ svg: input, removedCount: 0 });
  });
});

describe("reference rules: markers", () => {
  const arrow = '<marker id="m" markerWidth="4" markerHeight="4"><path d="M0 0L4 2L0 4z"/></marker>';

  test("keeps a diagram with an arrowhead on every edge unchanged", () => {
    const edges = '<path d="M0 0L100 0" marker-end="url(#m)"/>'.repeat(300);
    const input = svg(`<defs>${arrow}</defs>${edges}`);
    expect(cleanSvg(input, "docs_image")).toEqual({ svg: input, removedCount: 0 });
  });

  test("cuts marker-mid on a path with more vertices than the budget allows", () => {
    const d = `M0 0${" L1 1".repeat(15_000)}`;
    const { svg: output, removedCount } = cleanSvg(svg(`<defs>${arrow}</defs><path d="${d}" marker-mid="url(#m)"/>`), "docs_image");
    expect(output).not.toContain("marker-mid");
    expect(output).toContain(`d="${d}"`);
    expect(removedCount).toBe(1);
  });

  test("cuts markers that draw markers, which multiply", () => {
    const points = Array.from({ length: 200 }, (_, index) => `${index} ${index}`).join(" ");
    const input = svg(
      `<defs><marker id="m1"><path d="M0 0"/></marker>` +
        `<marker id="m2"><polyline points="${points}" marker-mid="url(#m1)"/></marker></defs>` +
        `<polyline points="${points}" marker-mid="url(#m2)"/>`,
    );
    const { svg: output } = cleanSvg(input, "docs_image");
    // The inner polyline keeps its markers; the outer one would draw 200 x 200 of them.
    expect(output).toContain('marker-mid="url(#m1)"');
    expect(output).not.toContain('marker-mid="url(#m2)"');
  });

  test("counts the pattern paint that context-fill passes into each marker", () => {
    const pattern = `<pattern id="p" width="4" height="4">${'<rect width="1" height="1"/>'.repeat(5_000)}</pattern>`;
    const marker = '<marker id="m"><path d="M0 0" fill="context-fill"/></marker>';
    const d = `M0 0${" L1 1".repeat(50)}`;
    const { svg: output } = cleanSvg(
      svg(`<defs>${pattern}${marker}</defs><path d="${d}" fill="url(#p)" marker-mid="url(#m)"/>`),
      "docs_image",
    );
    expect(output).toContain('fill="url(#p)"');
    expect(output).not.toContain("marker-mid");
  });

  test("drops a marker property on a group, where it would reach every child", () => {
    const { svg: output, removedCount } = cleanSvg(
      svg(`<defs>${arrow}</defs><g marker-end="url(#m)"><path d="M0 0L1 1"/></g>`),
      "docs_image",
    );
    expect(output).toContain("<g><path");
    expect(removedCount).toBe(1);
  });

  test("cuts a marker that draws itself", () => {
    const { svg: output } = cleanSvg(
      svg('<defs><marker id="m"><path d="M0 0L1 1" marker-end="url(#m)"/></marker></defs><path d="M0 0L1 1" marker-end="url(#m)"/>'),
      "docs_image",
    );
    expect(output.match(/marker-end/g)).toHaveLength(1);
  });
});

describe("reference rules: patterns, clip paths, and masks", () => {
  test("cuts nested patterns, which multiply", () => {
    let defs = '<pattern id="p0" width="1" height="1"><rect width="1" height="1"/></pattern>';
    for (let level = 1; level <= 6; level++) {
      defs += `<pattern id="p${level}" width="1" height="1">${`<rect width="1" height="1" fill="url(#p${level - 1})"/>`.repeat(10)}</pattern>`;
    }
    const { svg: output, removedCount } = cleanSvg(svg(`<defs>${defs}</defs><rect width="9" height="9" fill="url(#p6)"/>`), "docs_image");
    expect(removedCount).toBeGreaterThan(0);
    expect(output).not.toContain('<rect width="9" height="9" fill="url(#p6)"/>');
  });

  test("keeps a pattern fill on a shape, and a gradient fill anywhere", () => {
    const input = svg(
      '<defs><pattern id="p" width="4" height="4"><circle r="1"/></pattern><linearGradient id="g"><stop offset="0"/></linearGradient></defs>' +
        '<rect width="9" height="9" fill="url(#p)"/><g fill="url(#g)"><rect width="1" height="1"/></g>',
    );
    expect(cleanSvg(input, "docs_image")).toEqual({ svg: input, removedCount: 0 });
  });

  test("drops a pattern paint on a group, where it would reach every child", () => {
    const { svg: output, removedCount } = cleanSvg(
      svg('<defs><pattern id="p" width="4" height="4"><circle r="1"/></pattern></defs><g fill="url(#p)"><rect width="1" height="1"/></g>'),
      "docs_image",
    );
    expect(output).toContain("<g><rect");
    expect(removedCount).toBe(1);
  });

  test("cuts patterns whose href templates form a cycle", () => {
    const { svg: output } = cleanSvg(
      svg('<defs><pattern id="a" href="#b"/><pattern id="b" href="#a"/></defs><rect width="1" height="1" fill="url(#a)"/>'),
      "docs_image",
    );
    expect(output).not.toContain('href="#');
  });

  test("keeps the clip path that design tools export unchanged", () => {
    const input = svg(
      '<defs><path id="SVGID_1_" d="M0 0h10v10z"/></defs><clipPath id="SVGID_2_"><use href="#SVGID_1_"/></clipPath>' +
        '<g clip-path="url(#SVGID_2_)"><rect width="10" height="10"/></g>',
    );
    expect(cleanSvg(input, "site")).toEqual({ svg: input, removedCount: 0 });
  });

  test("caps the nodes that masks draw for every masked element", () => {
    const mask = `<mask id="k">${'<rect width="1" height="1"/>'.repeat(999)}</mask>`;
    const { svg: output, removedCount } = cleanSvg(
      svg(`<defs>${mask}</defs>${'<rect width="1" height="1" mask="url(#k)"/>'.repeat(100)}`),
      "docs_image",
    );
    expect(output.match(/mask="url\(#k\)"/g)).toHaveLength(20);
    expect(removedCount).toBe(80);
  });

  test("cuts a clip path that clips itself", () => {
    const { svg: output } = cleanSvg(
      svg('<clipPath id="c"><rect width="1" height="1" clip-path="url(#c)"/></clipPath><g clip-path="url(#c)"/>'),
      "site",
    );
    expect(output).not.toContain('<rect width="1" height="1" clip-path');
  });
});

describe("output", () => {
  test("is idempotent", () => {
    const input = svg(
      '<!-- c --><defs><g id="a"><path d="M0 0" onclick="x"/></g></defs><use href="#a"/><text>a &amp; b<![CDATA[<x>]]></text><script>1</script>',
    );
    const once = cleanSvg(input, "docs_image").svg;
    expect(cleanSvg(once, "docs_image")).toEqual({ svg: once, removedCount: 0 });
  });
});
