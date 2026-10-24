#!/usr/bin/env node
/**
 * Writes the Lucide icon data that docs pages draw, from the pinned
 * `lucide-static` and `@iconify-json/lucide` dev dependencies.
 *
 *   pnpm --filter @doxahq/docs-prose generate:icons
 *
 * Outputs, under `src/icons/generated/`:
 * - `lucide-core.ts`: the suggested icons only. Small, so apps import it
 *   eagerly and the common icons draw on the first frame.
 * - `lucide-icons.ts`: every icon, plus old names of renamed icons. Large,
 *   so apps load it lazily or on the server only.
 * - `lucide-tags.ts`: search words per icon, for the icon picker.
 * - `LUCIDE_LICENSE.txt`: the Lucide license, which must ship with the data.
 *
 * And, for the generation agent, `packages/agent/runtime/`:
 * - `lucide-icons.json`: every icon name with its search words, and the old
 *   names of renamed icons. No glyphs: the agent only picks names.
 * - `LUCIDE_LICENSE.txt`: the same license.
 *
 * Names are camelCase (`book-open` becomes `bookOpen`), the form that pages
 * store. A name that a previous run wrote must still resolve after an upgrade:
 * either Lucide still has it, or it is an alias of the icon that replaced it.
 * Otherwise the run fails, because a published page would lose its icon.
 */
import { readFileSync, writeFileSync, existsSync, mkdirSync } from "node:fs";
import { createRequire } from "node:module";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const require = createRequire(import.meta.url);
const packageRoot = join(dirname(fileURLToPath(import.meta.url)), "..");
const outputDirectory = join(packageRoot, "src", "icons", "generated");

const ELEMENTS = new Set(["path", "circle", "rect", "line", "ellipse", "polyline", "polygon"]);
const ATTRIBUTES = new Set([
  "d", "cx", "cy", "r", "rx", "ry", "x", "y", "x1", "x2", "y1", "y2", "width", "height", "points", "fill",
]);
const NAME_PATTERN = /^[a-z][A-Za-z0-9]{0,39}$/;

/**
 * Names that pages already store but Lucide no longer has, and that Iconify
 * does not list as aliases. `align-justify` became `text-align-justify`.
 */
const EXTRA_ALIASES = { "align-justify": "text-align-justify" };

const staticRoot = dirname(require.resolve("lucide-static/package.json"));
const lucideVersion = JSON.parse(readFileSync(join(staticRoot, "package.json"), "utf8")).version;
const iconNodes = JSON.parse(readFileSync(join(staticRoot, "icon-nodes.json"), "utf8"));
const iconTags = JSON.parse(readFileSync(join(staticRoot, "tags.json"), "utf8"));
const license = readFileSync(join(staticRoot, "LICENSE"), "utf8");
const iconify = JSON.parse(readFileSync(require.resolve("@iconify-json/lucide/icons.json"), "utf8"));
const suggested = readSuggestedNames();

function camelCase(kebab) {
  return kebab.replace(/-([a-z0-9])/g, (_, character) => character.toUpperCase());
}

function fail(message) {
  console.error(`generate-lucide-icons: ${message}`);
  process.exit(1);
}

/** The suggested names, read from the source so the two cannot drift. */
function readSuggestedNames() {
  const source = readFileSync(join(packageRoot, "src", "icon-names.ts"), "utf8");
  const list = source.match(/DOCS_ICON_NAMES = \[([\s\S]*?)\] as const/);
  if (!list) fail("cannot find DOCS_ICON_NAMES in src/icon-names.ts");
  return [...list[1].matchAll(/"([^"]+)"/g)].map((match) => match[1]);
}

/** Checks one icon and keeps only the elements and attributes a page may draw. */
function cleanNode(kebab, node) {
  if (!Array.isArray(node) || node.length === 0) fail(`icon ${kebab} has no elements`);
  return node.map(([element, attributes]) => {
    if (!ELEMENTS.has(element)) fail(`icon ${kebab} uses <${element}>`);
    const kept = {};
    for (const [name, value] of Object.entries(attributes)) {
      if (!ATTRIBUTES.has(name)) fail(`icon ${kebab} uses the attribute ${name}`);
      kept[name] = String(value);
    }
    return [element, kept];
  });
}

const icons = {};
const kebabNames = Object.keys(iconNodes).sort();
for (const kebab of kebabNames) {
  const name = camelCase(kebab);
  if (!NAME_PATTERN.test(name)) fail(`icon ${kebab} gives the name ${name}, which pages cannot store`);
  if (icons[name]) fail(`icons ${kebab} and another icon share the name ${name}`);
  icons[name] = cleanNode(kebab, iconNodes[kebab]);
}

const aliases = {};
const aliasSources = [
  ...Object.entries(iconify.aliases ?? {}).map(([alias, value]) => [alias, value.parent]),
  ...Object.entries(EXTRA_ALIASES),
];
for (const [aliasKebab, targetKebab] of aliasSources) {
  const alias = camelCase(aliasKebab);
  const target = camelCase(targetKebab);
  // Iconify can alias an alias, and can keep icons that Lucide removed.
  if (icons[alias] || !icons[target] || !NAME_PATTERN.test(alias)) continue;
  aliases[alias] = target;
}
const sortedAliases = Object.fromEntries(Object.entries(aliases).sort(([a], [b]) => a.localeCompare(b)));

function resolve(name) {
  return icons[name] ? name : sortedAliases[name];
}

for (const name of suggested) {
  if (!resolve(name)) fail(`the suggested icon ${name} is not in Lucide ${lucideVersion}; add an alias`);
}

const iconsFile = join(outputDirectory, "lucide-icons.ts");
for (const name of readPreviousNames(iconsFile)) {
  if (!resolve(name)) {
    fail(`Lucide ${lucideVersion} removed ${name}, which pages can store; add it to EXTRA_ALIASES`);
  }
}

/** The icon and alias names the previous run wrote, from its JSON payload. */
function readPreviousNames(file) {
  if (!existsSync(file)) return [];
  const payload = readFileSync(file, "utf8").match(/^const DATA = '(.*)';$/m);
  if (!payload) fail(`cannot read the previous data in ${file}`);
  const data = JSON.parse(payload[1].replace(/\\(.)/g, "$1"));
  return [...Object.keys(data.icons), ...Object.keys(data.aliases)];
}

const tags = {};
for (const kebab of kebabNames) {
  const words = (iconTags[kebab] ?? []).map((word) => String(word).toLowerCase());
  if (words.length > 0) tags[camelCase(kebab)] = [...new Set(words)];
}

const core = {};
for (const name of suggested) {
  const canonical = resolve(name);
  core[name] = icons[canonical];
  core[canonical] = icons[canonical];
}

const header = (description) => `/**
 * ${description}
 *
 * Generated by scripts/generate-lucide-icons.mjs from Lucide ${lucideVersion}. Do not edit.
 * Lucide is ISC licensed, with some icons under MIT: see ./LUCIDE_LICENSE.txt.
 */
`;

/**
 * Large data goes in as one JSON string: it parses faster than an object
 * literal and type-checks at once. Single quotes keep the JSON quotes
 * unescaped, which keeps the file small.
 */
function jsonModule(description, typeName, typeImport, data) {
  const literal = JSON.stringify(data).replace(/\\/g, "\\\\").replace(/'/g, "\\'");
  return `${header(description)}${typeImport}
const DATA = '${literal}';

export default JSON.parse(DATA) as ${typeName};
`;
}

mkdirSync(outputDirectory, { recursive: true });

writeFileSync(
  iconsFile,
  jsonModule(
    "Every Lucide icon by camelCase name, and the old names of renamed icons.",
    "LucideIconData",
    'import type { LucideIconData } from "../node";\n',
    { icons, aliases: sortedAliases },
  ),
);

writeFileSync(
  join(outputDirectory, "lucide-tags.ts"),
  jsonModule(
    "Search words for every Lucide icon, by camelCase name.",
    "Readonly<Record<string, readonly string[]>>",
    "",
    tags,
  ),
);

writeFileSync(
  join(outputDirectory, "lucide-core.ts"),
  `${header("The suggested docs icons, under their stored names and their current Lucide names.")}import type { DocsIconNode } from "../node";

export const LUCIDE_VERSION = ${JSON.stringify(lucideVersion)};

export const LUCIDE_ICON_COUNT = ${Object.keys(icons).length};

/** The suggested icons by their current Lucide names, in suggestion order. */
export const SUGGESTED_ICON_NAMES: readonly string[] = ${JSON.stringify(suggested.map(resolve))};

/** The current Lucide name of every name in \`CORE_ICON_NODES\`. */
export const CORE_ICON_CURRENT_NAMES: Readonly<Record<string, string>> = ${JSON.stringify(
  Object.fromEntries(Object.keys(core).sort((a, b) => a.localeCompare(b)).map((name) => [name, resolve(name)])),
)};

export const CORE_ICON_NODES: Readonly<Record<string, DocsIconNode>> = {
${Object.entries(core)
  .sort(([a], [b]) => a.localeCompare(b))
  .map(([name, node]) => `  ${name}: ${JSON.stringify(node)},`)
  .join("\n")}
};
`,
);

writeFileSync(join(outputDirectory, "LUCIDE_LICENSE.txt"), license);

const agentRuntime = join(packageRoot, "..", "agent", "runtime");
if (!existsSync(agentRuntime)) fail(`cannot find the agent runtime folder at ${agentRuntime}`);
writeFileSync(
  join(agentRuntime, "lucide-icons.json"),
  `${JSON.stringify({
    lucideVersion,
    icons: Object.fromEntries(Object.keys(icons).map((name) => [name, tags[name] ?? []])),
    aliases: sortedAliases,
  })}\n`,
);
writeFileSync(join(agentRuntime, "LUCIDE_LICENSE.txt"), license);

console.log(
  `Lucide ${lucideVersion}: ${Object.keys(icons).length} icons, ${Object.keys(sortedAliases).length} aliases, ${Object.keys(core).length} core names.`,
);
