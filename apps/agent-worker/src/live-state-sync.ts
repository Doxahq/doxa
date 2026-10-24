import {
  explainedBaselineHashes,
  flattenStructure,
  hashJson,
  hashPageInputs,
  isDocumentationStructure,
  legacyPageInputFields,
  pageOutputPath,
  routeFromOutputPath,
  sectionFolder,
  seedStructureFromSite,
  stablePageId,
  type DocPage,
  type DocSection,
  type DocumentationStructure,
} from "@doxahq/agent/structure";
import {
  emptyPageDependencyState,
  GENERATION_STATE_SCHEMA_VERSION,
  toJsonValue,
  type GenerationPageState,
  type ReusableGenerationState,
} from "@doxahq/contracts";
import { matchPages, normalizeHref, type MatchablePage } from "@doxahq/docs-engine";
import type { SiteNavigation, SitePageEntry } from "./seed-site";
import { personsValue, siteNavigationView, type SiteNavigationView } from "./site-navigation-view";

type StructureTarget = ReturnType<typeof flattenStructure>[number];

/** What the sync reads besides the stored state. */
export interface LiveStateSyncReaders {
  /** Reads a file of the live version by its path inside the version. */
  readLive(path: string): Promise<string | null>;
  /** Reads a page artifact that the generation state stores. */
  readArtifact(key: string): Promise<string | null>;
  hashContent(content: string): Promise<string>;
}

/** How the live site differs from the generation state that the run starts from. */
export interface LiveStateSyncSummary {
  /** Pages that a person moved to another route. */
  moved: number;
  /** Pages that kept their route and got another title. */
  retitled: number;
  /** Pages that a person deleted from the live site. */
  removed: number;
  /** Pages that a person created on the live site. */
  added: number;
}

const NO_LIVE_CHANGES: LiveStateSyncSummary = { moved: 0, retitled: 0, removed: 0, added: 0 };

export interface LiveStateSync {
  state: ReusableGenerationState;
  summary: LiveStateSyncSummary;
}

/** One page of the stored structure, as the sync compares it. */
interface StatePage extends MatchablePage {
  target: StructureTarget;
  /** The page's position in the stored structure. */
  index: number;
  record: GenerationPageState | undefined;
}

/** One page of the live site, as the sync compares it. */
interface LivePage extends MatchablePage {
  target: StructureTarget;
  entry: SitePageEntry;
}

/**
 * The generation state that a run starts from, brought up to date with the
 * live site, so a run never undoes what a person changed there.
 *
 * The stored state gives what the generation needs to write a page again:
 * its brief, evidence, reference data and dependencies. The live site gives
 * every page's route and file, and the pages that exist: a page that a
 * person deleted leaves the state, and a page that a person created joins it
 * from its live file, with no evidence, so no run rewrites it. Pages are
 * matched by `matchPages` (route, then body, then title).
 *
 * A title, a section label, a group, the navigation visibility and the
 * order follow the live site where a person changed them, that is where the
 * live value differs from the value in the version that the state was
 * written with (`generated`). The generation derives some of them when it
 * publishes, so the live value alone does not say what a person set.
 * Without that version, titles and section labels compare with the stored
 * state, and placements keep their stored values.
 *
 * A person's change keeps the page's input hash, so it does not make the
 * run write the page again.
 */
export async function syncReusableStateWithLive(input: {
  state: ReusableGenerationState;
  live: SiteNavigation;
  /** The navigation of the version that the state was written with, or null when its files are gone. */
  generated: SiteNavigation | null;
  /** The prefix of the live version's files. */
  liveArtifactPrefix: string;
  readers: LiveStateSyncReaders;
}): Promise<LiveStateSync> {
  const stored = input.state.structure.structure;
  if (!isDocumentationStructure(stored)) {
    return { state: input.state, summary: NO_LIVE_CHANGES };
  }

  const recordsById = new Map(input.state.pages.map((record) => [record.pageId, record]));
  const statePages = flattenStructure(stored).map((target, index): StatePage => ({
    href: routeOf(target),
    title: target.page.title,
    section: target.sectionId,
    content: null,
    target,
    index,
    record: recordsById.get(stablePageId(target)),
  }));
  const views: NavigationViews = {
    live: siteNavigationView(input.live),
    generated: input.generated ? siteNavigationView(input.generated) : null,
  };
  const liveStructure = withStoredSectionIds(
    seedStructureFromSite({ sections: input.live.sections, pages: input.live.pages }),
    stored,
  );
  const entriesByHref = new Map(input.live.pages.map((entry) => [normalizeHref(entry.href), entry]));
  const livePages = flattenStructure(liveStructure).flatMap((target): LivePage[] => {
    const href = routeOf(target);
    const entry = entriesByHref.get(href);
    return entry ? [{ href, title: entry.title, section: target.sectionId, content: null, target, entry }] : [];
  });

  await readBodiesOutsideShared(statePages, livePages, input.readers);
  const matching = matchPages(statePages, livePages);
  const stateByLiveHref = new Map(matching.matches.map((match) => [match.current.href, match.previous]));

  const synced = syncedStructure({ liveStructure, livePages, stateByLiveHref, stored, views });
  const [syncedHash, storedHash] = await Promise.all([hashJson(synced), hashJson(stored)]);
  if (syncedHash === storedHash) return { state: input.state, summary: NO_LIVE_CHANGES };

  const records = await syncedRecords({
    synced,
    stored,
    livePages,
    stateByLiveHref,
    liveArtifactPrefix: input.liveArtifactPrefix,
    hashContent: input.readers.hashContent,
  });

  return {
    state: {
      ...input.state,
      structure: { ...input.state.structure, structure: toJsonValue(synced), structureHash: syncedHash },
      pages: records,
    },
    summary: summaryOf(matching.matches, synced, matching),
  };
}

/** The views of the live version and of the version that the state was written with. */
interface NavigationViews {
  live: SiteNavigationView;
  generated: SiteNavigationView | null;
}

function summaryOf(
  matches: readonly { previous: StatePage; current: LivePage }[],
  synced: DocumentationStructure,
  matching: { unmatchedPrevious: readonly unknown[]; unmatchedCurrent: readonly unknown[] },
): LiveStateSyncSummary {
  const syncedTitles = new Map(flattenStructure(synced).map((target) => [routeOf(target), target.page.title]));
  return {
    moved: matches.filter(({ previous, current }) => previous.href !== current.href).length,
    retitled: matches.filter(({ previous, current }) =>
      previous.href === current.href && syncedTitles.get(current.href) !== previous.title
    ).length,
    removed: matching.unmatchedPrevious.length,
    added: matching.unmatchedCurrent.length,
  };
}

/** The route of a structure page, as page records and the live manifest write it. */
function routeOf(target: StructureTarget): string {
  return normalizeHref(routeFromOutputPath(target.path));
}

/**
 * The live structure with the section IDs of the stored one. The live site
 * names a section by its folder, so a live section takes the ID of the
 * stored section with that folder.
 */
function withStoredSectionIds(live: DocumentationStructure, stored: DocumentationStructure): DocumentationStructure {
  const storedIdByFolder = new Map(stored.sections.map((section) => [sectionFolder(section), section.id]));
  return {
    sections: live.sections.map((section) => ({ ...section, id: storedIdByFolder.get(section.id) ?? section.id })),
  };
}

/**
 * Reads the text of the pages whose route the other side lacks: only they
 * can need the body or title match. A live page that cannot be read stops
 * the sync, as a run must never guess a person's page.
 */
async function readBodiesOutsideShared(
  statePages: StatePage[],
  livePages: LivePage[],
  readers: LiveStateSyncReaders,
): Promise<void> {
  const liveHrefs = new Set(livePages.map((page) => page.href));
  const stateHrefs = new Set(statePages.map((page) => page.href));
  await Promise.all([
    ...statePages
      .filter((page) => !liveHrefs.has(page.href) && page.record)
      .map(async (page) => {
        page.content = page.record ? await readers.readArtifact(page.record.artifactKey) : null;
      }),
    ...livePages
      .filter((page) => !stateHrefs.has(page.href))
      .map(async (page) => {
        page.content = await readLivePage(page, readers);
      }),
  ]);
}

async function readLivePage(page: LivePage, readers: LiveStateSyncReaders): Promise<string> {
  const content = await readers.readLive(page.entry.sourcePath);
  if (content === null) throw new Error(`The live page ${page.href} could not be read.`);
  return content;
}

/** One page of the synced structure, before it gets its final ID, route and place. */
interface PlacedPage {
  page: DocPage;
  href: string;
  /** Whether the page carries a stored page's ID. */
  matched: boolean;
  /** Whether a navigation lists the page. */
  listed: boolean;
  /** The page's position in the stored structure, if it has a stored page. */
  storedIndex: number | undefined;
  /** The page's position in the navigation that the generation published, if it listed the page. */
  generatedIndex: number | undefined;
}

/**
 * The synced structure. Its sections follow the live site, and each page
 * carries the generation inputs of its stored page with what a person
 * changed on the live site. A matched page keeps its stored ID, and a page
 * that a person created gets a free one. A hidden page comes after the
 * listed ones, in its stored section when it has one.
 */
function syncedStructure(input: {
  liveStructure: DocumentationStructure;
  livePages: readonly LivePage[];
  stateByLiveHref: ReadonlyMap<string, StatePage>;
  stored: DocumentationStructure;
  views: NavigationViews;
}): DocumentationStructure {
  const livePageOf = new Map(input.livePages.map((page) => [page.target.page, page]));
  const sectionIds = new Set(input.liveStructure.sections.map((section) => section.id));
  const placedBySection = new Map<string, PlacedPage[]>(input.liveStructure.sections.map((section) => [section.id, []]));

  for (const liveSection of input.liveStructure.sections) {
    for (const seedPage of liveSection.pages) {
      const live = livePageOf.get(seedPage);
      if (!live) continue;
      const state = input.stateByLiveHref.get(live.href);
      const placed = state ? placedStoredPage(state, live, input.views) : placedNewPage(seedPage, live, input.views);
      const sectionId = !placed.listed && state && sectionIds.has(state.target.sectionId)
        ? state.target.sectionId
        : liveSection.id;
      placedBySection.get(sectionId)?.push(placed);
    }
  }

  const storedSections = new Map(input.stored.sections.map((section) => [section.id, section]));
  return {
    sections: input.liveStructure.sections.map((liveSection) => {
      const placed = placedBySection.get(liveSection.id) ?? [];
      const ordered = [...inPersonsOrder(placed.filter((page) => page.listed)), ...placed.filter((page) => !page.listed)];
      return withSectionFields(
        storedSections.get(liveSection.id),
        liveSection,
        withFreeIdsAndRoutes(liveSection, ordered),
        input.views,
      );
    }),
  };
}

/** A stored page with what a person changed on the live site: its title, group and visibility. */
function placedStoredPage(state: StatePage, live: LivePage, views: NavigationViews): PlacedPage {
  const stored = state.target.page;
  const livePlacement = views.live.placements.get(live.href);
  const generatedPlacement = views.generated ? views.generated.placements.get(state.href) : livePlacement;
  const title = personsValue(
    stored.title,
    views.generated?.titles.get(state.href) ?? stored.title,
    live.title,
  );
  const group = personsValue(stored.group, generatedPlacement?.group, livePlacement?.group);
  const listed = personsValue(
    stored.navVisibility !== "hidden",
    generatedPlacement !== undefined,
    livePlacement !== undefined,
  );
  const { group: _group, navVisibility: _visibility, ...inputs } = stored;
  return {
    page: {
      ...inputs,
      title,
      ...(group ? { group } : {}),
      ...(listed ? {} : { navVisibility: "hidden" }),
    },
    href: live.href,
    matched: true,
    listed: listed && livePlacement !== undefined,
    storedIndex: state.index,
    generatedIndex: generatedPlacement?.index,
  };
}

/** A page that a person created, as the live site shows it. */
function placedNewPage(seedPage: DocPage, live: LivePage, views: NavigationViews): PlacedPage {
  const placement = views.live.placements.get(live.href);
  const { group: _group, canonicalRoute: _route, ...page } = seedPage;
  return {
    page: {
      ...page,
      title: live.title,
      ...(placement?.group ? { group: placement.group } : {}),
      ...(placement ? {} : { navVisibility: "hidden" }),
    },
    href: live.href,
    matched: false,
    listed: placement !== undefined,
    storedIndex: undefined,
    generatedIndex: undefined,
  };
}

/**
 * The listed pages of one section in the order that a person gave them.
 * Where a person neither reordered the pages nor added one, the stored order
 * stays: the generation derives the published order when it publishes.
 */
function inPersonsOrder(listed: readonly PlacedPage[]): PlacedPage[] {
  const generatedOrder = listed.flatMap((page) => (page.generatedIndex === undefined ? [] : [page.generatedIndex]));
  const reordered = generatedOrder.some((index, position) => index < (generatedOrder[position - 1] ?? index));
  const added = listed.some((page) => page.storedIndex === undefined);
  if (reordered || added) return [...listed];
  return [...listed].sort((a, b) => (a.storedIndex ?? 0) - (b.storedIndex ?? 0));
}

/**
 * The pages of one section with unique IDs and their live routes. Matched
 * pages keep their stored IDs first. A page that a person created takes the
 * next free one.
 */
function withFreeIdsAndRoutes(section: DocSection, placed: readonly PlacedPage[]): DocPage[] {
  const taken = new Set<string>();
  const reserved = new Set(placed.filter((entry) => entry.matched).map((entry) => entry.page.id));
  return placed.map(({ page, href, matched }) => {
    const id = freeId(page.id, (candidate) => taken.has(candidate) || (!matched && reserved.has(candidate)));
    taken.add(id);
    return withRoute(section, { ...page, id }, href);
  });
}

/** `candidate`, or the first `candidate-N` that is not taken. */
function freeId(candidate: string, isTaken: (id: string) => boolean): string {
  let id = candidate;
  for (let suffix = 2; isTaken(id); suffix += 1) id = `${candidate}-${suffix}`;
  return id;
}

/**
 * The section with the fields that only the stored section has, its live
 * default flag, and the label that a person gave it.
 */
function withSectionFields(
  stored: DocSection | undefined,
  live: DocSection,
  pages: DocPage[],
  views: NavigationViews,
): DocSection {
  const { default: _storedDefault, ...fields } = stored ?? live;
  const slug = sectionFolder(live);
  const title = stored
    ? personsValue(stored.title, views.generated?.sectionLabels.get(slug) ?? stored.title, live.title)
    : live.title;
  return { ...fields, title, pages, ...(live.default ? { default: true } : {}) };
}

/**
 * The page at its live route. A stored canonical route that already gives
 * the live route stays. Otherwise one is set only where the section and the
 * page ID alone would give another route, so a page that a person never
 * moved keeps the structure, and its input hash, as stored.
 */
function withRoute(section: DocSection, page: DocPage, href: string): DocPage {
  if (page.canonicalRoute !== undefined && normalizeHref(page.canonicalRoute) === href) return page;
  const { canonicalRoute: _staleRoute, ...routeless } = page;
  if (normalizeHref(routeFromOutputPath(pageOutputPath(section, routeless))) === href) return routeless;
  return { ...routeless, canonicalRoute: href };
}

/**
 * The page records of the synced structure. A matched page keeps its record
 * under its new ID and route, and points at the live file when it moved.
 * Its input hash follows the synced structure when the stored hash matched
 * the stored structure, so a person's rename does not count as a new input;
 * any other stored hash stays, and the page is written again. A page that a
 * person created gets a record of its live file.
 */
async function syncedRecords(input: {
  synced: DocumentationStructure;
  stored: DocumentationStructure;
  livePages: readonly LivePage[];
  stateByLiveHref: ReadonlyMap<string, StatePage>;
  liveArtifactPrefix: string;
  hashContent: (content: string) => Promise<string>;
}): Promise<GenerationPageState[]> {
  const [syncedHashes, storedHashes, legacyHashes] = await Promise.all([
    hashPageInputs(input.synced),
    hashPageInputs(input.stored),
    hashPageInputs(input.stored, legacyPageInputFields),
  ]);
  const storedRecords = [...input.stateByLiveHref.values()].flatMap((page) => (page.record ? [page.record] : []));
  const comparable = explainedBaselineHashes({
    stored: Object.fromEntries(storedRecords.map((record) => [record.pageId, record.pageInputHash])),
    current: storedHashes,
    legacy: legacyHashes,
  });
  const livePageByHref = new Map(input.livePages.map((page) => [page.href, page]));

  return Promise.all(
    flattenStructure(input.synced).map(async (target): Promise<GenerationPageState> => {
      const pageId = stablePageId(target);
      const route = routeOf(target);
      const live = livePageByHref.get(route);
      const liveFile = live ? { key: `${input.liveArtifactPrefix}/${live.entry.sourcePath}`, content: live.content } : null;
      const state = input.stateByLiveHref.get(route);

      if (!state?.record) {
        return newRecord({ pageId, target, route, hash: syncedHashes[pageId], liveFile, hashContent: input.hashContent });
      }

      const storedId = state.record.pageId;
      const explained = comparable[storedId] === storedHashes[storedId];
      const movedTo = state.href === route ? null : readFile(liveFile);
      return {
        ...state.record,
        pageId,
        title: target.page.title,
        route,
        navigationPath: target.path,
        pageInputHash: explained ? syncedHashes[pageId] : state.record.pageInputHash,
        ...(movedTo ? { artifactKey: movedTo.key, contentHash: await input.hashContent(movedTo.content) } : {}),
      };
    }),
  );
}

interface LiveFile {
  key: string;
  content: string | null;
}

/** The live file with its text, or null when it was not read. */
function readFile(file: LiveFile | null): { key: string; content: string } | null {
  return file && file.content !== null ? { key: file.key, content: file.content } : null;
}

/** The record of a page that only the live site has: its live file, with nothing to regenerate from. */
async function newRecord(input: {
  pageId: string;
  target: StructureTarget;
  route: string;
  hash: string;
  liveFile: LiveFile | null;
  hashContent: (content: string) => Promise<string>;
}): Promise<GenerationPageState> {
  const file = readFile(input.liveFile);
  if (!file) throw new Error(`The live page ${input.route} could not be read.`);
  return {
    schemaVersion: GENERATION_STATE_SCHEMA_VERSION,
    pageId: input.pageId,
    title: input.target.page.title,
    route: input.route,
    navigationPath: input.target.path,
    artifactKey: file.key,
    contentHash: await input.hashContent(file.content),
    pageInputHash: input.hash,
    dependencies: emptyPageDependencyState(),
  };
}
