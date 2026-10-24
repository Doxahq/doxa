import { type DocsManifest } from "@doxahq/docs-engine";
import { relativeNavigationPathForSection } from "@doxahq/contracts/docs-branches";
import type { StoredBranchChange } from "../../repositories/docs-branches";
import {
  parseDocsManifest,
  parseJsonArrayArtifact,
  readSectionSlugs,
  toJsonArtifact,
} from "../docs-content/artifacts";
import { DocsContentError } from "../docs-content/errors";
import type { DocsContentStore } from "../docs-content/store";
import { unmeasured, type MeasureStep } from "../request-timing";

export type EffectiveTreeChange = Pick<StoredBranchChange, "path"> &
  ({ kind: "upsert"; content: string } | { kind: "delete"; content: null });

export interface EffectiveContent {
  manifest: DocsManifest;
  navigation: {
    sectionsArtifact: unknown[];
    documentsBySection: Map<string, unknown[]>;
  };
}

export class EffectiveTree {
  private readonly changes: ReadonlyMap<string, EffectiveTreeChange>;
  private sourcePathsPromise: Promise<Set<string>> | null = null;

  constructor(
    private readonly store: Pick<DocsContentStore, "read" | "listKeys">,
    readonly basePrefix: string,
    changes: readonly EffectiveTreeChange[],
    /** Measures the manifest and navigation reads for Server-Timing. */
    private readonly measure: MeasureStep = unmeasured,
  ) {
    this.changes = new Map(changes.map((change) => [change.path, change]));
  }

  read(path: string): Promise<string | null> {
    const change = this.changes.get(path);

    if (change) {
      return Promise.resolve(change.kind === "upsert" ? change.content : null);
    }

    return this.store.read(`${this.basePrefix}/${path}`);
  }

  readBase(key: string): Promise<string | null> {
    return this.store.read(key);
  }

  async listEffectiveSourcePaths(): Promise<string[]> {
    return [...(await this.sourcePaths())].sort();
  }

  /**
   * Answers from one listing of `source/` instead of a GET per path, so a
   * check over every page costs one request. Other paths are still read.
   */
  async exists(path: string): Promise<boolean> {
    if (!path.startsWith("source/")) {
      return (await this.read(path)) !== null;
    }

    return (await this.sourcePaths()).has(path);
  }

  private sourcePaths(): Promise<Set<string>> {
    if (!this.sourcePathsPromise) {
      const listing = this.listSourcePaths();
      listing.catch(() => {
        if (this.sourcePathsPromise === listing) {
          this.sourcePathsPromise = null;
        }
      });
      this.sourcePathsPromise = listing;
    }

    return this.sourcePathsPromise;
  }

  private async listSourcePaths(): Promise<Set<string>> {
    const prefix = `${this.basePrefix}/`;
    const baseKeys = await this.store.listKeys(`${prefix}source/`);
    const paths = new Set(baseKeys.map((key) => key.slice(prefix.length)));

    for (const change of this.changes.values()) {
      if (!change.path.startsWith("source/")) {
        continue;
      }

      if (change.kind === "delete") {
        paths.delete(change.path);
      } else {
        paths.add(change.path);
      }
    }

    return paths;
  }

  async readBytes(path: string): Promise<Uint8Array | null> {
    const content = await this.read(path);
    return content === null ? null : new TextEncoder().encode(content);
  }

  /** The effective manifest, parsed only through `parseDocsManifest`. */
  async manifest(): Promise<DocsManifest> {
    const manifestRaw = await this.measure("r2.manifest", () =>
      this.read("manifest.json"),
    );
    const manifest = manifestRaw ? parseDocsManifest(manifestRaw) : null;

    if (!manifest) {
      throw new DocsContentError(
        "invalid",
        "The documentation manifest could not be read.",
      );
    }

    return manifest;
  }

  /**
   * The manifest and the navigation. The manifest and the section list do
   * not depend on each other, so they are read at the same time. A manifest
   * error still wins over a navigation error.
   */
  async content(): Promise<EffectiveContent> {
    const navigationRead = this.measure("r2.nav", () => this.navigation());
    // Awaited below. This only stops an unhandled rejection when the
    // manifest fails first.
    navigationRead.catch(() => undefined);
    const manifest = await this.manifest();
    return { manifest, navigation: await navigationRead };
  }

  private async navigation(): Promise<EffectiveContent["navigation"]> {
    const sectionsRaw = await this.read("settings/sections.json");
    const sectionsArtifact = sectionsRaw
      ? (parseJsonArrayArtifact(sectionsRaw) ?? [])
      : [];
    const slugs = readSectionSlugs(toJsonArtifact(sectionsArtifact));
    const documentsBySection = new Map<string, unknown[]>();
    await Promise.all(
      (slugs.length > 0 ? slugs : ["default"]).map(async (slug) => {
        const path = relativeNavigationPathForSection(slug);
        const raw = await this.read(path);
        const nodes = raw ? parseJsonArrayArtifact(raw) : null;

        if (nodes) {
          documentsBySection.set(slug, nodes);
        }
      }),
    );

    return { sectionsArtifact, documentsBySection };
  }
}
