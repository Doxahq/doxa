import { readFile, writeFile } from "node:fs/promises";
import { createRequire } from "node:module";
import { dirname, join } from "node:path";
import { RuntimeMdxContent } from "../../../packages/docs-prose/src/render/runtime-mdx-content";
import { createProseComponents } from "../../../packages/docs-prose/src/components/registry";
import { createPre } from "../../../packages/docs-prose/src/components/pre";

const require = createRequire(new URL("../../../packages/docs-prose/package.json", import.meta.url));
const React = require("react");
// The standalone TSX loader can compile imported JSX in classic mode.
// Supply its React binding in this test process without editing shared components.
(globalThis as { React?: unknown }).React = React;
const { renderToStaticMarkup } = require("react-dom/server");
const path = process.argv[2]!;
const pages = JSON.parse(await readFile(path, "utf8")) as Array<{
  ast: Parameters<typeof RuntimeMdxContent>[0]["document"];
  content: string;
}>;
const EmptyIcon = () => null;
const components = createProseComponents({
  overrides: { pre: createPre({ copy: EmptyIcon, copied: EmptyIcon }) },
});
for (const [index, page] of pages.entries()) {
  const html = renderToStaticMarkup(
    React.createElement(RuntimeMdxContent, { document: page.ast, components }),
  );
  await writeFile(join(dirname(path), `page-${index}.html`), html);
}
