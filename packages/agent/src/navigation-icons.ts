import { existsSync } from "fs";
import { readFile } from "fs/promises";
import { createHash } from "crypto";
import { dirname, join } from "path";
import { fileURLToPath } from "url";
import {
  ProjectPathAccessError,
  resolveProjectPath,
} from "./core/tools/project-path";

export interface IconSchemaOption {
  name: string;
  title: string;
  description: string;
  keywords: readonly string[];
}

/** A Lucide icon as the agent matches it: its name and its search words. */
export interface LucideIconEntry {
  name: string;
  /** The words of the name ("ship", "wheel"), stemmed. */
  nameWords: readonly string[];
  /** Lucide's search words, stemmed, without common words. Phrases keep their spaces. */
  tags: readonly string[];
}

/**
 * The icons a generated page can use: the suggested icons, which carry
 * guidance, and every Lucide icon, which the docs renderer and the editor can
 * draw. Without the Lucide catalog file, only the suggested icons.
 */
export interface IconCatalog {
  /** The suggested icons, with titles, descriptions and keywords. */
  options: readonly IconSchemaOption[];
  /** Every icon name a page may store: the suggested names and every Lucide icon. */
  names: ReadonlySet<string>;
  /** Old Lucide names of renamed icons, to their current names. */
  aliases: Readonly<Record<string, string>>;
  lucide: readonly LucideIconEntry[];
  lucideVersion: string | null;
  prompt: string;
  schemaHash: string;
}

interface JsonSchemaOption {
  const?: unknown;
  title?: unknown;
  description?: unknown;
  "x-keywords"?: unknown;
}

interface IconsSchema {
  oneOf?: unknown;
}

const FALLBACK_ICON_OPTIONS = [
  ["alignJustify", "Text layout", "navigation layout formatting menu text sidebar"],
  ["arrowUpRight", "External link", "external link redirect open outbound"],
  ["beaker", "Experiment", "testing experiment lab preview validation"],
  ["book", "Documentation", "documentation docs guide manual reference"],
  ["bookOpen", "Learning", "learn tutorial concept introduction education"],
  ["box", "Component", "component package module asset block"],
  ["circleHelp", "Help", "help faq troubleshooting support error issue"],
  ["code", "Code", "code sdk api client source programming snippet"],
  ["cog", "Configuration", "configuration config options preferences settings"],
  ["compass", "Overview", "overview orientation introduction start roadmap"],
  ["database", "Data", "database data storage content index persistence"],
  ["file", "File", "file markdown document page content"],
  ["flag", "Release", "release milestone goal status launch roadmap"],
  ["folder", "Project structure", "folder structure directory project organization tree"],
  ["globe", "Web", "web website hosting network global internet"],
  ["house", "Home", "home landing root dashboard main"],
  ["key", "Authentication", "auth authentication authorization secret token credential key"],
  ["layers", "Architecture", "architecture system layers stack composition flow"],
  ["list", "Reference list", "list reference index catalog collection navigation"],
  ["package", "Package", "package install installation dependency distribution release"],
  ["play", "Quickstart", "quickstart run demo start getting started first steps"],
  ["plug", "Integration", "integration plugin adapter connector provider extension"],
  ["rocket", "Launch", "launch setup onboarding quickstart deploy start"],
  ["search", "Search", "search discovery index filter lookup find"],
  ["server", "Server", "server backend api deployment hosting infrastructure"],
  ["settings", "Settings", "settings customization theme preferences controls feature flags"],
  ["shield", "Security", "security privacy permissions policy protection safe"],
  ["terminal", "CLI", "cli terminal shell command script tool"],
  ["wrench", "Development", "development maintenance contributing debugging tool operations"],
  ["zap", "Automation", "ai automation performance realtime shortcut fast"],
] as const;

let cachedDefaultCatalog: Promise<IconCatalog> | undefined;

export async function loadIconCatalog(cwd?: string): Promise<IconCatalog> {
  const raw = cwd ? await readWorkspaceIconSchema(cwd) : null;
  if (raw) return buildIconCatalog(parseIconSchema(raw), raw, await loadLucideCatalog());

  cachedDefaultCatalog ??= loadLucideCatalog().then((lucide) =>
    buildIconCatalog(parseFallbackIconOptions(), JSON.stringify(FALLBACK_ICON_OPTIONS), lucide),
  );
  return cachedDefaultCatalog;
}

interface LucideCatalogFile {
  lucideVersion: string;
  icons: Record<string, string[]>;
  aliases: Record<string, string>;
}

const LUCIDE_CATALOG_PATH = join("runtime", "lucide-icons.json");
let cachedLucideCatalog: Promise<LucideCatalogFile | null> | undefined;

/**
 * The Lucide catalog from `runtime/lucide-icons.json`, which ships beside the
 * bundle (`@doxahq/docs-prose` generates it). Null where there is no
 * filesystem or no file, so the agent keeps to the suggested icons.
 */
function loadLucideCatalog(): Promise<LucideCatalogFile | null> {
  cachedLucideCatalog ??= (async () => {
    try {
      let dir = dirname(fileURLToPath(import.meta.url));
      for (let depth = 0; depth < 12; depth++) {
        const candidate = join(dir, LUCIDE_CATALOG_PATH);
        if (existsSync(candidate)) {
          return JSON.parse(await readFile(candidate, "utf-8")) as LucideCatalogFile;
        }
        const parent = dirname(dir);
        if (parent === dir) break;
        dir = parent;
      }
    } catch {
      // No filesystem (a Worker) or an unreadable file: keep to the suggested icons.
    }
    return null;
  })();
  return cachedLucideCatalog;
}

/**
 * The name a page stores for an icon the model wrote, or null when it is no
 * icon. Accepts camelCase, kebab-case (`ship-wheel`) and PascalCase, and
 * follows Lucide renames. A suggested name stays as it is.
 */
export function resolveIconName(catalog: IconCatalog, value: string | undefined | null): string | null {
  if (typeof value !== "string") return null;
  const key = toIconKey(value);
  if (!key) return null;
  if (catalog.names.has(key)) return key;
  const renamed = catalog.aliases[key];
  return renamed && catalog.names.has(renamed) ? renamed : null;
}

function toIconKey(value: string): string | null {
  const trimmed = value.trim();
  const camel = /^[A-Z][A-Za-z0-9]*$/.test(trimmed)
    ? trimmed.charAt(0).toLowerCase() + trimmed.slice(1)
    : /^[a-z][A-Za-z0-9]*$/.test(trimmed)
      ? trimmed
      : trimmed.toLowerCase().replace(/[-_\s]+([a-z0-9])/g, (_, character: string) => character.toUpperCase());
  return ICON_KEY_PATTERN.test(camel) ? camel : null;
}

const ICON_KEY_PATTERN = /^[a-z][A-Za-z0-9]{0,39}$/;

interface IconMatchInput {
  title: string;
  section: string;
  head: string;
  filename: string;
}

interface MatchField {
  kind: "title" | "head" | "filename" | "section";
  text: string;
  words: ReadonlySet<string>;
  /** The words without common words, stemmed, for Lucide matching. */
  stems: ReadonlySet<string>;
  weight: number;
}

/**
 * Words too common to choose an icon by: English filler, and words every
 * docs page shares. Without this list "Users and teams" picks the ampersand.
 */
const STOP_WORDS = new Set(
  (
    "a an and are as at be by can do docs doc documentation default first for from get guide how in index into is it its md mdx " +
    "more of on or other our out page pages per run the this that to up use using we what when with you your"
  ).split(" "),
);

/** A crude singular, so "webhooks" finds the webhook icon and "policies" the policy one. */
function stem(word: string): string {
  if (word.length > 4 && word.endsWith("ies")) return `${word.slice(0, -3)}y`;
  if (word.length > 3 && word.endsWith("s") && !word.endsWith("ss")) return word.slice(0, -1);
  return word;
}

function stemPhrase(phrase: string): string {
  return phrase
    .split(" ")
    .map(stem)
    .join(" ");
}

function matchFields(input: IconMatchInput): MatchField[] {
  const fields = [
    { kind: "title", text: input.title, weight: 6 },
    { kind: "head", text: input.head, weight: 3 },
    { kind: "filename", text: input.filename, weight: 2 },
    { kind: "section", text: input.section, weight: 1 },
  ] as const;
  return fields.map(({ kind, text, weight }) => {
    const normalized = normalizeText(text);
    const words = normalized.split(" ");
    return {
      kind,
      text: normalized,
      words: new Set(words),
      stems: new Set(words.filter((word) => word && !STOP_WORDS.has(word)).map(stem)),
      weight,
    };
  });
}

/** How well a list of words describes a page: each word found in a field adds that field's weight. */
function scoreWords(words: readonly string[], fields: readonly MatchField[]): number {
  let total = 0;
  for (const word of words) {
    if (!word) continue;
    const phrase = word.includes(" ");
    for (const field of fields) {
      const found = phrase ? containsWholePhrase(field.text, word) : field.words.has(word);
      if (found) total += field.weight * Math.max(2, word.split(" ").length * 2);
    }
  }
  return total;
}

/**
 * How well a Lucide icon describes a page. Its name counts double: a page
 * titled "Webhooks" is about the webhook icon, not about every icon that
 * lists "webhook" among its search words.
 */
function scoreLucideEntry(entry: LucideIconEntry, fields: readonly MatchField[]): number {
  let total = 0;
  for (const field of fields) {
    const stemmedText = ` ${[...field.stems].join(" ")} `;
    for (const word of entry.nameWords) {
      if (field.stems.has(word)) total += field.weight * 4;
    }
    for (const tag of entry.tags) {
      const found = tag.includes(" ") ? stemmedText.includes(` ${tag} `) : field.stems.has(tag);
      if (found) total += field.weight * 2;
    }
  }
  return total;
}

function suggestedWords(option: IconSchemaOption): string[] {
  return [option.name, option.title, option.description, ...option.keywords].map(normalizeText);
}

/**
 * Lucide's search words are broad ("app", "page"), so a Lucide icon must
 * match clearly better than the best suggested icon to replace it.
 */
const LUCIDE_SCORE_FACTOR = 0.75;

/**
 * The Lucide icons that best match a page, best first: a short list the
 * ordering prompt offers beside the suggested icons.
 */
export function iconCandidates(catalog: IconCatalog, input: IconMatchInput, limit = 8): string[] {
  if (catalog.lucide.length === 0) return [];
  const fields = matchFields(input);
  const scored: { name: string; score: number }[] = [];
  for (const entry of catalog.lucide) {
    const score = scoreLucideEntry(entry, fields);
    if (score > 0) scored.push({ name: entry.name, score });
  }
  scored.sort((a, b) => b.score - a.score || a.name.length - b.name.length || a.name.localeCompare(b.name));
  return scored.slice(0, limit).map((match) => match.name);
}

/**
 * A deterministic icon for a page, from its title, head, filename and
 * section. A suggested icon wins when it matches about as well as any Lucide
 * icon; a Lucide icon covers topics the suggested ones miss (payments, email,
 * webhooks). "file" when nothing matches.
 */
export function chooseFallbackIcon(catalog: IconCatalog, input: IconMatchInput): string {
  const fields = matchFields(input);
  let best = "file";
  let bestScore = 0;

  for (const option of catalog.options) {
    const score = scoreWords(suggestedWords(option), fields);
    if (score > bestScore) {
      best = option.name;
      bestScore = score;
    }
  }

  // A Lucide icon must match the title or the filename: a match in the page
  // text alone ("requests per minute") is too weak to name the page.
  const naming = fields.filter((field) => field.kind === "title" || field.kind === "filename");
  for (const entry of catalog.lucide) {
    if (scoreLucideEntry(entry, naming) === 0) continue;
    const score = scoreLucideEntry(entry, fields) * LUCIDE_SCORE_FACTOR;
    if (score > bestScore) {
      best = entry.name;
      bestScore = score;
    }
  }

  return catalog.names.has(best) ? best : "file";
}

async function readWorkspaceIconSchema(cwd: string): Promise<string | null> {
  try {
    const schemaPath = await resolveProjectPath(
      cwd,
      "src/schemas/icons.schema.json",
    );
    return await readFile(schemaPath, "utf-8");
  } catch (error) {
    if (error instanceof ProjectPathAccessError) throw error;
    return null;
  }
}

function parseIconSchema(raw: string): IconSchemaOption[] {
  const parsed = JSON.parse(raw) as IconsSchema;
  const oneOf = Array.isArray(parsed.oneOf) ? parsed.oneOf : [];
  const options = oneOf
    .map(toIconSchemaOption)
    .filter((option): option is IconSchemaOption => option !== null);
  return options.length > 0 ? options : parseFallbackIconOptions();
}

function toIconSchemaOption(entry: unknown): IconSchemaOption | null {
  if (!entry || typeof entry !== "object") return null;
  const option = entry as JsonSchemaOption;
  if (typeof option.const !== "string") return null;
  const keywords = Array.isArray(option["x-keywords"])
    ? option["x-keywords"].filter((keyword): keyword is string => typeof keyword === "string")
    : [];
  return {
    name: option.const,
    title: typeof option.title === "string" ? option.title : option.const,
    description: typeof option.description === "string" ? option.description : option.const,
    keywords,
  };
}

function parseFallbackIconOptions(): IconSchemaOption[] {
  return FALLBACK_ICON_OPTIONS.map(([name, title, keywordText]) => ({
    name,
    title,
    description: title,
    keywords: keywordText.split(" "),
  }));
}

function buildIconCatalog(
  options: readonly IconSchemaOption[],
  rawSchema: string,
  lucide: LucideCatalogFile | null,
): IconCatalog {
  const lucideEntries: LucideIconEntry[] = lucide
    ? Object.entries(lucide.icons).map(([name, tags]) => ({
        name,
        nameWords: normalizeText(name.replace(/([A-Z])/g, " $1"))
          .split(" ")
          .filter((word) => word && !STOP_WORDS.has(word))
          .map(stem),
        tags: [
          ...new Set(
            tags
              .map(normalizeText)
              .filter((tag) => tag && !STOP_WORDS.has(tag))
              .map(stemPhrase),
          ),
        ],
      }))
    : [];
  const names = new Set([...options.map((option) => option.name), ...lucideEntries.map((entry) => entry.name)]);
  const suggested = options
    .map((option) => {
      const keywords = option.keywords.length ? ` Keywords: ${option.keywords.join(", ")}.` : "";
      return `- ${option.name}: ${option.title}. ${option.description}${keywords}`;
    })
    .join("\n");
  const prompt = lucide
    ? `Suggested icons (prefer one when it fits the page):
${suggested}

Any other Lucide icon also works (${lucideEntries.length.toLocaleString("en-US")} icons, https://lucide.dev/icons). Write its name in camelCase: "creditCard" for credit-card, "shipWheel" for ship-wheel. Each page lists "icon candidates": Lucide icons that match its title and content. Use one when it describes the page better than a suggested icon. Never invent an icon name.`
    : suggested;
  return {
    options,
    names,
    aliases: lucide?.aliases ?? {},
    lucide: lucideEntries,
    lucideVersion: lucide?.lucideVersion ?? null,
    prompt,
    schemaHash: createHash("sha256")
      .update(rawSchema)
      .update(`lucide:${lucide?.lucideVersion ?? "none"}`)
      .digest("hex")
      .slice(0, 16),
  };
}

function normalizeText(value: string): string {
  return value.toLowerCase().replace(/[^a-z0-9]+/g, " ").replace(/\s+/g, " ").trim();
}

function containsWholePhrase(text: string, phrase: string): boolean {
  return ` ${text} `.includes(` ${phrase} `);
}
