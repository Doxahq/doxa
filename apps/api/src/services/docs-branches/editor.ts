import {
  canonicalJson,
  type JsonObject,
  type JsonValue,
} from "@doxahq/contracts/docs-prerender";
import { normalizeHref, sourcePathForHref } from "@doxahq/docs-engine";
import { relativeNavigationPathForSection } from "@doxahq/contracts/docs-branches";
import type { DocsContentEdit } from "@doxahq/contracts";
import type { ResolvedSiteConfig } from "@doxahq/site-config";
import type {
  BranchChangeWrite,
  StoredBranchChange,
} from "../../repositories/docs-branches";
import type { PublishedDocsContentVersion } from "../../repositories/docs-content";
import type { PageHrefMove } from "../../repositories/generation-review-records";
import {
  contentStructureFromArtifacts,
  contentStructureToArtifacts,
  applyStructureEdit,
  type ContentStructure,
  type StructureBodyWrite,
} from "../docs-content/structure";
import {
  rewriteFrontmatterTitle,
  toJsonArtifact,
} from "../docs-content/artifacts";
import { DocsContentError } from "../docs-content/errors";
import type { EntitlementsService } from "../entitlements";
import type { SiteAssetStore } from "../site-assets/store";
import {
  assertSearchChoiceAllowed,
  validateConfigForSite,
} from "../docs-content/site-config";
import { EffectiveTree } from "./effective-tree";
import { prepareWorkingChanges, type DesiredChange } from "./working-changes";

const SITE_CONFIG_PATH = "settings/site.json";

export interface EditWrites {
  writes: BranchChangeWrite[];
  /** The pages that the edits renamed or moved to another href, from first to last href. */
  hrefMoves: PageHrefMove[];
}

export async function buildEditWrites(input: {
  tree: EffectiveTree;
  existing: readonly StoredBranchChange[];
  edits: readonly DocsContentEdit[];
  main: PublishedDocsContentVersion;
  entitlements: EntitlementsService;
  assets: Pick<SiteAssetStore, "head">;
  /** The site config of the published version, for a branch without its own. */
  publishedSiteConfig: () => Promise<ResolvedSiteConfig>;
}): Promise<EditWrites> {
  const effective = await input.tree.content();
  let structure = contentStructureFromArtifacts(
    effective.manifest,
    effective.navigation.sectionsArtifact,
    effective.navigation.documentsBySection,
  );
  const desired = new Map<string, DesiredChange>();
  const hrefMoves = new HrefMoves();
  let structureChanged = false;
  // The working site config, loaded only when an edit touches the home page.
  // Null means "read it again", for example after a whole-config edit.
  let siteConfig: JsonObject | null = null;
  const loadSiteConfig = async () =>
    (siteConfig ??= await readWorkingSiteConfig(input, desired));
  const saveSiteConfig = (config: JsonObject) =>
    desired.set(SITE_CONFIG_PATH, canonicalJson(config));

  for (const edit of input.edits) {
    if (edit.type === "set_home_page") {
      const config = await loadSiteConfig();
      if (edit.href === null) {
        delete config.homePage;
      } else {
        config.homePage = normalizeHref(findPage(structure, edit.href).href);
      }
      saveSiteConfig(config);
      continue;
    }

    if (edit.type === "set_site_config") {
      const config = await validateConfigForSite(
        edit.config,
        input.main,
        input.entitlements,
        input.assets,
      );
      await assertSearchChoiceAllowed({
        choice: config.features.searchProvider,
        readPreviousChoice: async () => {
          const { features } = await loadSiteConfig();
          return features && typeof features === "object" && !Array.isArray(features)
            ? features.searchProvider
            : undefined;
        },
        projectId: input.main.projectId,
        entitlements: input.entitlements,
      });

      desired.set(SITE_CONFIG_PATH, canonicalJson(config));
      siteConfig = null;
      continue;
    }

    if (edit.type === "reset_site_config") {
      desired.set(SITE_CONFIG_PATH, undefined);
      siteConfig = null;
      continue;
    }

    if (edit.type === "set_page_content" || edit.type === "reset_page") {
      const page = findPage(structure, edit.href);

      if (
        edit.type === "reset_page" &&
        (await input.tree.readBase(
          `${input.tree.basePrefix}/${sourcePathForHref(page.href)}`,
        )) === null
      ) {
        throw new DocsContentError(
          "invalid",
          "This page has no published content to restore.",
        );
      }

      desired.set(
        sourcePathForHref(page.href),
        edit.type === "set_page_content" ? edit.content : undefined,
      );
      continue;
    }

    const previous = structure;
    const result = applyStructureEdit(previous, edit);

    for (const bodyWrite of result.bodyWrites) {
      if (bodyWrite.type === "remove") {
        desired.set(sourcePathForHref(bodyWrite.href), null);
        continue;
      }

      const content = await resolveBodyWrite(
        input.tree,
        previous,
        desired,
        bodyWrite,
      );

      if (
        bodyWrite.type === "copy" &&
        bodyWrite.fromHref !== bodyWrite.toHref
      ) {
        desired.set(sourcePathForHref(bodyWrite.fromHref), null);
      }

      desired.set(
        sourcePathForHref(
          bodyWrite.type === "create" ? bodyWrite.href : bodyWrite.toHref,
        ),
        content,
      );
    }
    structure = result.structure;
    structureChanged = true;
    hrefMoves.follow(result.bodyWrites);

    // A renamed or moved home page keeps its place. A deleted one is
    // dropped, so the site root shows the first page again.
    if (result.bodyWrites.some((write) => write.type !== "create")) {
      const config = await loadSiteConfig();
      const homePage = followHomePage(
        config.homePage,
        result.bodyWrites,
        structure,
      );
      if (homePage !== config.homePage) {
        if (homePage === undefined) delete config.homePage;
        else config.homePage = homePage;
        saveSiteConfig(config);
      }
    }
  }

  if (structureChanged) {
    const artifacts = contentStructureToArtifacts(
      structure,
      effective.manifest,
    );
    desired.set("manifest.json", toJsonArtifact(artifacts.manifest));
    desired.set(
      "settings/sections.json",
      toJsonArtifact(artifacts.sectionsArtifact),
    );

    for (const [slug, nodes] of artifacts.documentsBySection) {
      desired.set(
        relativeNavigationPathForSection(slug),
        toJsonArtifact(nodes),
      );
    }

    for (const slug of effective.navigation.documentsBySection.keys()) {
      if (!artifacts.documentsBySection.has(slug)) {
        desired.set(relativeNavigationPathForSection(slug), null);
      }
    }
  }

  return {
    writes: await prepareWorkingChanges({
      store: { read: (key) => input.tree.readBase(key) },
      basePrefix: input.tree.basePrefix,
      existing: input.existing,
      desired,
    }),
    hrefMoves: hrefMoves.list(),
  };
}

/**
 * Follows each page through the edits of one save, so a page renamed twice
 * moves once, from its first href to its last.
 */
class HrefMoves {
  /** The current href of each moved page, by its first href. */
  private readonly current = new Map<string, string>();

  follow(bodyWrites: readonly StructureBodyWrite[]): void {
    for (const write of bodyWrites) {
      if (write.type !== "copy") continue;
      const from = normalizeHref(write.fromHref);
      const to = normalizeHref(write.toHref);
      if (from === to) continue;
      const first =
        [...this.current].find(([, href]) => href === from)?.[0] ?? from;
      this.current.set(first, to);
    }
  }

  list(): PageHrefMove[] {
    return [...this.current]
      .filter(([from, to]) => from !== to)
      .map(([from, to]) => ({ from, to }));
  }
}

/** Where the home page is after one structure edit, or undefined when it is gone. */
function followHomePage(
  homePage: JsonValue | undefined,
  bodyWrites: readonly StructureBodyWrite[],
  structure: ContentStructure,
): JsonValue | undefined {
  if (typeof homePage !== "string") return homePage;
  let href = normalizeHref(homePage);
  for (const write of bodyWrites) {
    if (write.type === "copy" && normalizeHref(write.fromHref) === href) {
      href = normalizeHref(write.toHref);
    }
  }
  const exists = structure.pages.some(
    (page) => normalizeHref(page.href) === href,
  );
  if (!exists) return undefined;
  return href === normalizeHref(homePage) ? homePage : href;
}

/**
 * The site config of the branch as a JSON object: the pending value of this
 * save, else the stored one, else the published one. It stays a raw object,
 * so that a home page change keeps every other field byte for byte.
 */
async function readWorkingSiteConfig(
  input: {
    tree: EffectiveTree;
    publishedSiteConfig: () => Promise<ResolvedSiteConfig>;
  },
  desired: ReadonlyMap<string, DesiredChange>,
): Promise<JsonObject> {
  let text: string | null;
  if (desired.has(SITE_CONFIG_PATH)) {
    const pending = desired.get(SITE_CONFIG_PATH);
    text =
      typeof pending === "string"
        ? pending
        : await input.tree.readBase(
            `${input.tree.basePrefix}/${SITE_CONFIG_PATH}`,
          );
  } else {
    text = await input.tree.read(SITE_CONFIG_PATH);
  }
  if (text !== null) {
    // Stored configs are JSON that a save already validated.
    const parsed: JsonValue = JSON.parse(text);
    if (parsed && typeof parsed === "object" && !Array.isArray(parsed)) {
      return { ...parsed };
    }
  }
  return { ...(await input.publishedSiteConfig()) };
}

function findPage(
  structure: ContentStructure,
  href: string,
): ContentStructure["pages"][number] {
  const target = normalizeHref(href);
  const page = structure.pages.find(
    (candidate) => normalizeHref(candidate.href) === target,
  );

  if (!page) {
    throw new DocsContentError("not_found", `No page exists at ${target}.`);
  }

  return page;
}

async function resolveBodyWrite(
  tree: EffectiveTree,
  structure: ContentStructure,
  desired: ReadonlyMap<string, DesiredChange>,
  write: Exclude<StructureBodyWrite, { type: "remove" }>,
): Promise<string> {
  if (write.type === "create") {
    return write.content;
  }

  const source = findPage(structure, write.fromHref);
  const path = sourcePathForHref(source.href);
  const pending = desired.get(path);
  const content = desired.has(path)
    ? pending === undefined
      ? await tree.readBase(`${tree.basePrefix}/${path}`)
      : pending
    : await tree.read(path);

  if (content === null || content === undefined) {
    throw new DocsContentError(
      "invalid",
      `The page at ${write.fromHref} has no source content to copy.`,
    );
  }

  return rewriteFrontmatterTitle(content, write.title);
}
